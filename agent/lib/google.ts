import {
  ConnectError,
  deleteTokenCacheEntry,
  getTokenResponse,
  NoValidTokenError,
  revokeToken,
  startAuthorization,
  UserAuthorizationRequiredError,
  type ConnectTokenParams,
  type ConnectTokenSubject,
} from "@vercel/connect";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { env } from "#lib/env.js";
import { googleAccountRegistry, type GoogleAccountRegistry, normalizeAccountLabel } from "#lib/google-accounts.js";
import { blobGoogleAccountStore } from "#lib/google-accounts-store.js";
import type { HomeOwner } from "#lib/home-target.js";
import { composeEmail } from "#lib/mime.js";
import { memoryCache, secretCache, type SharedCache } from "#lib/shared-cache.js";
import { startOfLocalDay } from "#lib/zoned-time.js";

const userinfoUrl = "https://openidconnect.googleapis.com/v1/userinfo";
const gmailBase = "https://gmail.googleapis.com/gmail/v1/users/me";
const calendarBase = "https://www.googleapis.com/calendar/v3";

const gmailReadScope = "https://www.googleapis.com/auth/gmail.readonly";
// Gmail has no draft-only scope: compose also allows sending, which Adam deliberately has no tool for.
const gmailDraftScope = "https://www.googleapis.com/auth/gmail.compose";
const calendarReadScope = "https://www.googleapis.com/auth/calendar.readonly";
const calendarEventsScope = "https://www.googleapis.com/auth/calendar.events";
export const googleScopes = [
  "openid",
  "email",
  gmailReadScope,
  gmailDraftScope,
  calendarReadScope,
  calendarEventsScope,
] as const;

const summaryHeaders = ["From", "To", "Subject", "Date"];
const replyHeaders = ["From", "Reply-To", "Subject", "Message-ID", "References"];

const retryDelayMs = 500;
const maxBodyChars = 8000;
const maxDescriptionChars = 1500;
const eventPageSize = 100;
const maxEventPages = 3;
const metadataConcurrency = 5;
const addressTtlSeconds = 24 * 60 * 60;
const tokenCacheMarginSeconds = 5 * 60;

// The slice of @vercel/connect this file uses, so tests can stand in for Vercel Connect.
export interface GoogleConnect {
  getToken(
    connector: string,
    params: ConnectTokenParams,
    options?: { forceRefresh?: boolean },
  ): Promise<{ token: string; expiresAt: number }>;
  startAuthorization(connector: string, params: ConnectTokenParams): Promise<{ url: string; expiresAt?: number }>;
  revokeToken(connector: string, params: { subject: ConnectTokenSubject }): Promise<void>;
  deleteTokenCacheEntry(connector: string, params: ConnectTokenParams): void;
}

const vercelConnect: GoogleConnect = {
  getToken: (connector, params, options) => getTokenResponse(connector, params, options),
  startAuthorization: (connector, params) => startAuthorization(connector, params),
  revokeToken: (connector, params) => revokeToken(connector, params),
  deleteTokenCacheEntry: (connector, params) => deleteTokenCacheEntry(connector, params),
};

export class GoogleNotConfiguredError extends Error {
  constructor() {
    super("Google isn't configured: set GOOGLE_CONNECTOR to the Vercel Connect Google connector.");
  }
}

export class NoGoogleAccountsError extends Error {
  constructor() {
    super(
      "No Google account is connected yet. The user adds one by asking in a direct chat with you " +
        "(connect_google_account, named like work or personal).",
    );
  }
}

export class GoogleNeedsConnectingError extends Error {
  readonly account: string;

  constructor(account: string, reason: string) {
    super(
      `The ${account} Google account ${reason}. A sign-in link only goes out when the user asks in a ` +
        "direct chat with you (connect_google_account); tell them that instead of retrying.",
    );
    this.account = account;
  }
}

export class GoogleApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type GoogleOwner = HomeOwner;

export interface GoogleAccountInfo {
  readonly account: string;
  readonly email: string | null;
  readonly status: "connected" | "needs_connecting" | "error";
  readonly error?: string;
}

export interface GoogleSignIn {
  readonly account: string;
  readonly added: boolean;
  readonly url: string;
  readonly expiresAt: Date | null;
}

export type GoogleDisconnect =
  | {
      readonly disconnected: true;
      readonly account: string;
      readonly hadGrant: boolean;
      readonly warning?: string;
    }
  | { readonly disconnected: false; readonly account: string; readonly reason: string };

export interface EmailSummary {
  readonly account: string;
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly date: Date | null;
  readonly snippet: string;
  readonly unread: boolean;
  readonly important: boolean;
  readonly category: EmailCategory;
}

// Gmail's inbox tabs; mail with no category label sits in Primary.
export type EmailCategory = "primary" | "social" | "promotions" | "updates" | "forums";

export interface EmailAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface Email extends EmailSummary {
  readonly cc: string;
  readonly body: string;
  readonly truncated: boolean;
  readonly attachments: readonly EmailAttachment[];
}

export type EventTime = { readonly allDay: true; readonly date: string } | { readonly allDay: false; readonly at: Date };

export interface CalendarEvent {
  readonly account: string;
  readonly calendar: string;
  readonly calendarId: string;
  readonly id: string;
  readonly title: string;
  readonly start: EventTime;
  readonly end: EventTime;
  readonly location: string;
  readonly description: string;
  readonly organizer: string;
  readonly attendees: readonly string[];
  readonly myResponse: string | null;
  readonly link: string | null;
  readonly meetLink: string | null;
}

export interface DraftRequest {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  // A reply takes its subject from the email it answers, so Gmail keeps it in that thread.
  readonly subject?: string;
  readonly body: string;
  readonly replyTo?: string;
}

export interface EmailDraft {
  readonly account: string;
  readonly id: string;
  readonly threadId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly link: string;
}

export interface EventRef {
  readonly calendarId: string;
  readonly id: string;
}

export interface NewEvent {
  readonly title: string;
  readonly start: EventTime;
  readonly end: EventTime;
  readonly location: string;
  readonly description: string;
  readonly attendees: readonly string[];
  readonly meet: boolean;
}

export interface EventChanges {
  readonly title?: string;
  readonly start?: EventTime;
  readonly end?: EventTime;
  readonly location?: string;
  readonly description?: string;
  readonly addAttendees?: readonly string[];
  readonly removeAttendees?: readonly string[];
}

export interface AccountError {
  readonly account: string;
  readonly error: string;
  readonly needsConnecting: boolean;
}

export interface AcrossAccounts<T> {
  readonly results: T[];
  readonly errors: AccountError[];
  // More matched than was returned: narrow the query or the range to see the rest.
  readonly truncated: boolean;
}

export interface MailboxWatch {
  readonly historyId: string;
  readonly expiresAt: Date;
}

export interface MailboxHistory {
  readonly addedMessageIds: string[];
  readonly historyId: string;
  readonly nextPageToken: string | null;
}

// One event as a calendar's sync reports it. `event` is null for a deletion Google reports by id only.
export interface EventRevision {
  readonly id: string;
  readonly updated: string;
  readonly cancelled: boolean;
  // A plain event, not a birthday, focus time, out of office, working location or one Gmail made.
  readonly ordinary: boolean;
  readonly organizedByOwner: boolean;
  readonly recurring: boolean;
  readonly instanceOf: string | null;
  readonly originalStart: EventTime | null;
  readonly declinedBy: readonly string[];
  readonly event: CalendarEvent | null;
}

export interface CalendarChangesPage {
  readonly revisions: EventRevision[];
  readonly nextPageToken: string | null;
  // Only on the last page.
  readonly nextSyncToken: string | null;
}

export interface CalendarWatch {
  readonly channelId: string;
  readonly resourceId: string;
  readonly expiresAt: Date;
}

export interface CalendarWatchRequest {
  readonly calendarId: string;
  readonly channelId: string;
  readonly address: string;
  readonly token: string;
  readonly ttlSeconds: number;
}

interface Page<T> {
  readonly items: T[];
  readonly more: boolean;
  readonly errors?: AccountError[];
}

interface MessagePart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: MessagePart[];
}

const partSchema: z.ZodType<MessagePart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z
      .object({
        size: z.number().optional(),
        data: z.string().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(partSchema).optional(),
  }),
);

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(""),
  internalDate: z.string().optional(),
  payload: partSchema.optional(),
});

const messageListSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

const calendarListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().default(""),
        summaryOverride: z.string().optional(),
        primary: z.boolean().default(false),
        selected: z.boolean().default(false),
        accessRole: z.string().optional(),
      }),
    )
    .default([]),
});

const eventTimeSchema = z.object({ date: z.string().optional(), dateTime: z.string().optional() });

const personSchema = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
  responseStatus: z.string().optional(),
  self: z.boolean().optional(),
});

const eventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().default(""),
  description: z.string().default(""),
  location: z.string().default(""),
  htmlLink: z.string().optional(),
  hangoutLink: z.string().optional(),
  start: eventTimeSchema,
  end: eventTimeSchema,
  organizer: personSchema.optional(),
  attendees: z.array(personSchema).default([]),
});

const draftSchema = z.object({ id: z.string(), message: z.object({ id: z.string(), threadId: z.string() }) });

const eventListSchema = z.object({
  items: z.array(eventSchema).default([]),
  nextPageToken: z.string().optional(),
});


const userinfoSchema = z.object({ email: z.string() });

const watchSchema = z.object({ historyId: z.string(), expiration: z.string() });

const profileSchema = z.object({ emailAddress: z.string(), historyId: z.string() });

const historySchema = z.object({
  history: z
    .array(z.object({ messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).default([]) }))
    .default([]),
  historyId: z.string(),
  nextPageToken: z.string().optional(),
});

const revisionSchema = eventSchema.extend({
  start: eventTimeSchema.optional(),
  end: eventTimeSchema.optional(),
  updated: z.string().default(""),
  eventType: z.string().default("default"),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: eventTimeSchema.optional(),
});

const changesSchema = z.object({
  items: z.array(revisionSchema).default([]),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
});

// Descriptions are left out: a change trigger never needs one, and they are where invite spam lives.
const changeFields =
  "nextPageToken,nextSyncToken,items(id,status,summary,location,htmlLink,hangoutLink,start,end,organizer," +
  "attendees(email,displayName,responseStatus,self),recurrence,recurringEventId,originalStartTime,updated,eventType)";
const changesPageSize = 2500;

const channelSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  expiration: z.union([z.string(), z.number()]).optional(),
});

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return entities[name.toLowerCase()] ?? match;
  });
}

function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset?.trim() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function qBytes(text: string): Uint8Array {
  const bytes: number[] = [];
  const source = text.replace(/_/gu, " ");
  for (let i = 0; i < source.length; i += 1) {
    const hex = source.slice(i + 1, i + 3);
    if (source[i] === "=" && /^[0-9a-f]{2}$/iu.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(source.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

const encodedWord = /=\?([^?]+)\?([bq])\?([^?]*)\?=/giu;
const encodedWordRun = /=\?[^?]+\?[bq]\?[^?]*\?=(?:\s+=\?[^?]+\?[bq]\?[^?]*\?=)*/giu;

// Adjacent encoded words may split one multi-byte character, so a run's bytes are decoded together.
export function decodeEncodedWords(value: string): string {
  return value.replace(encodedWordRun, (run) => {
    let decoded = "";
    let charset: string | undefined;
    let pending: number[] = [];
    const flush = () => {
      if (pending.length) decoded += decodeBytes(Uint8Array.from(pending), charset);
      pending = [];
    };
    for (const [, rawCharset = "", encoding = "", text = ""] of run.matchAll(encodedWord)) {
      const wordCharset = rawCharset.split("*")[0];
      if (wordCharset?.toLowerCase() !== charset?.toLowerCase()) flush();
      charset = wordCharset;
      const bytes = encoding.toLowerCase() === "b" ? Buffer.from(text, "base64") : qBytes(text);
      pending.push(...bytes);
    }
    flush();
    return decoded;
  });
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "- ")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|section|article|header|footer)\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, "");
  return normalizeWhitespace(decodeEntities(text));
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/gu, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isReplyHeader(line: string, next: string | undefined): boolean {
  if (/^-{2,}\s*Original Message\s*-{2,}$/iu.test(line.trim())) return true;
  if (!/^On\s/u.test(line)) return false;
  return /wrote:\s*$/u.test(line) || (next !== undefined && /wrote:\s*$/u.test(next));
}

export function trimQuotedReply(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex((line, index) => index > 0 && isReplyHeader(line, lines[index + 1]));
  const kept = cut === -1 ? lines : lines.slice(0, cut);
  const unquoted = kept.filter((line) => !line.startsWith(">"));
  const result = unquoted.join("\n").trim();
  return result || text.trim();
}

function header(part: MessagePart | undefined, name: string): string {
  const found = part?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return found ? decodeEncodedWords(found.value).trim() : "";
}

function charsetOf(part: MessagePart): string | undefined {
  return /charset="?([^";\s]+)/iu.exec(header(part, "Content-Type"))?.[1];
}

export function emailBody(payload: MessagePart | undefined): {
  text: string;
  attachments: EmailAttachment[];
} {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: EmailAttachment[] = [];

  const walk = (part: MessagePart) => {
    if (part.filename || part.body?.attachmentId) {
      if (part.filename) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType ?? "application/octet-stream",
          size: part.body?.size ?? 0,
        });
      }
      return;
    }
    if (part.parts?.length) {
      part.parts.forEach(walk);
      return;
    }
    const data = part.body?.data;
    if (!data) return;
    const text = decodeBytes(Buffer.from(data, "base64url"), charsetOf(part));
    const mimeType = part.mimeType?.toLowerCase();
    if (mimeType === "text/plain") plain.push(text);
    else if (mimeType === "text/html") html.push(text);
  };

  if (payload) walk(payload);
  const text = plain.length ? normalizeWhitespace(plain.join("\n\n")) : htmlToText(html.join("\n"));
  return { text: trimQuotedReply(text), attachments };
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const splitsPair = /[\uD800-\uDBFF]/u.test(text[max - 1] ?? "");
  return { text: `${text.slice(0, splitsPair ? max - 1 : max)}…`, truncated: true };
}

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const categoryLabels: Record<string, EmailCategory> = {
  CATEGORY_PERSONAL: "primary",
  CATEGORY_SOCIAL: "social",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
};

function categoryOf(labelIds: readonly string[]): EmailCategory {
  for (const label of labelIds) {
    const category = categoryLabels[label];
    if (category) return category;
  }
  return "primary";
}

function toSummary(account: string, raw: z.infer<typeof messageSchema>): EmailSummary {
  return {
    account,
    id: raw.id,
    threadId: raw.threadId,
    from: header(raw.payload, "From"),
    to: header(raw.payload, "To"),
    subject: header(raw.payload, "Subject"),
    date: raw.internalDate ? new Date(Number(raw.internalDate)) : null,
    snippet: decodeEntities(raw.snippet),
    unread: raw.labelIds.includes("UNREAD"),
    important: raw.labelIds.includes("IMPORTANT"),
    category: categoryOf(raw.labelIds),
  };
}

function toEventTime(time: z.infer<typeof eventTimeSchema>): EventTime {
  if (time.dateTime) return { allDay: false, at: new Date(time.dateTime) };
  return { allDay: true, date: time.date ?? "" };
}

function shiftDay(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(parsed) ? date : new Date(parsed + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Google's all-day end date is exclusive; the domain's is the last day the event covers.
function toEventEnd(start: EventTime, end: z.infer<typeof eventTimeSchema>): EventTime {
  const time = toEventTime(end);
  if (!time.allDay || !start.allDay) return time;
  const last = shiftDay(time.date, -1);
  return { allDay: true, date: last < start.date ? start.date : last };
}

function person(raw: z.infer<typeof personSchema> | undefined): string {
  if (!raw) return "";
  if (raw.displayName && raw.email) return `${raw.displayName} <${raw.email}>`;
  return raw.displayName ?? raw.email ?? "";
}

function toEvent(
  account: string,
  calendar: { id: string; name: string },
  raw: z.infer<typeof eventSchema>,
): CalendarEvent {
  return {
    account,
    calendar: calendar.name,
    calendarId: calendar.id,
    id: raw.id,
    title: raw.summary,
    start: toEventTime(raw.start),
    end: toEventEnd(toEventTime(raw.start), raw.end),
    location: raw.location,
    description: truncate(htmlToText(raw.description), maxDescriptionChars).text,
    organizer: person(raw.organizer),
    attendees: raw.attendees.filter((attendee) => !attendee.self).map(person).filter(Boolean),
    myResponse: raw.attendees.find((attendee) => attendee.self)?.responseStatus ?? null,
    link: raw.htmlLink ?? null,
    meetLink: raw.hangoutLink ?? null,
  };
}

function hasTime(time: z.infer<typeof eventTimeSchema> | undefined): time is z.infer<typeof eventTimeSchema> {
  return Boolean(time?.date || time?.dateTime);
}

function toRevision(
  account: string,
  calendar: { id: string; name: string },
  raw: z.infer<typeof revisionSchema>,
): EventRevision {
  const { start, end } = raw;
  return {
    id: raw.id,
    updated: raw.updated,
    cancelled: raw.status === "cancelled",
    ordinary: raw.eventType === "default",
    organizedByOwner: raw.organizer?.self === true,
    recurring: Boolean(raw.recurrence?.length),
    instanceOf: raw.recurringEventId ?? null,
    originalStart: hasTime(raw.originalStartTime) ? toEventTime(raw.originalStartTime) : null,
    declinedBy: raw.attendees
      .filter((attendee) => !attendee.self && attendee.responseStatus === "declined")
      .map(person)
      .filter(Boolean),
    event: hasTime(start) && hasTime(end) ? toEvent(account, calendar, { ...raw, start, end }) : null,
  };
}

function toGoogleTime(time: EventTime, timeZone: string) {
  return time.allDay ? { date: time.date } : { dateTime: time.at.toISOString(), timeZone };
}

function toGoogleEnd(end: EventTime, timeZone: string) {
  return end.allDay ? { date: shiftDay(end.date, 1) } : toGoogleTime(end, timeZone);
}

export function checkEventSpan(start: EventTime, end: EventTime): void {
  if (start.allDay !== end.allDay) {
    throw new Error("An event's start and end must both be dates (all day) or both be times.");
  }
  const inOrder =
    start.allDay && end.allDay ? end.date >= start.date : !start.allDay && !end.allDay && end.at > start.at;
  if (!inOrder) throw new Error("An event has to end after it starts.");
}

function mergeAttendees(
  current: readonly z.infer<typeof personSchema>[],
  add: readonly string[],
  remove: readonly string[],
) {
  const kept = current.filter(
    (attendee) => attendee.email && !remove.some((email) => sameAddress(email, attendee.email ?? "")),
  );
  const added = add.filter((email) => !kept.some((attendee) => sameAddress(email, attendee.email ?? "")));
  return [
    ...kept.map(({ email, displayName, responseStatus }) => ({ email, displayName, responseStatus })),
    ...added.map((email) => ({ email })),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toAccountError(account: string, error: unknown): AccountError {
  return {
    account,
    error: errorMessage(error),
    needsConnecting: error instanceof GoogleNeedsConnectingError,
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

interface Account {
  readonly label: string;
  readonly owner: GoogleOwner;
}

// Connect keys a grant by connector and subject, so each account gets its own subject under the
// owner and one connector holds them all.
export function googleSubject(owner: GoogleOwner, label: string): ConnectTokenSubject {
  return { type: "user", id: `${owner.principalId}/google/${label}`, issuer: owner.issuer };
}

function isMissingGrant(error: unknown): boolean {
  if (error instanceof UserAuthorizationRequiredError || error instanceof NoValidTokenError) return true;
  return error instanceof ConnectError && error.status === 404;
}

function labelOf(name: string): string | null {
  try {
    return normalizeAccountLabel(name);
  } catch {
    return null;
  }
}

interface GoogleCallOptions {
  readonly method?: "GET" | "POST" | "PATCH";
  readonly body?: unknown;
  readonly idempotent?: boolean;
}

export interface GoogleWorkspaceDeps {
  readonly connector: string | undefined;
  readonly accounts: GoogleAccountRegistry;
  readonly timeZone: string;
  readonly connect?: GoogleConnect;
  readonly addressCache?: SharedCache;
  readonly tokenCache?: SharedCache;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function googleWorkspace(deps: GoogleWorkspaceDeps) {
  const { connector, accounts: registry, timeZone } = deps;
  const connect = deps.connect ?? vercelConnect;
  const tokenCache = deps.tokenCache ?? secretCache;
  const request = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const addresses = deps.addressCache ?? memoryCache();

  function eventSortKey(time: EventTime): number {
    if (!time.allDay) return time.at.getTime();
    try {
      return startOfLocalDay(time.date, timeZone).getTime();
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  function tokenParams(account: Account): ConnectTokenParams {
    return { subject: googleSubject(account.owner, account.label), scopes: [...googleScopes] };
  }

  function connectorFor(owner: GoogleOwner | null): { connector: string; owner: GoogleOwner } {
    if (!connector) throw new GoogleNotConfiguredError();
    if (!owner) {
      throw new Error("Google accounts belong to the user, and this turn carries no user identity to read them as.");
    }
    return { connector, owner };
  }

  function tokenCacheKey(account: Account): string {
    return `google-token:${connector}:${JSON.stringify(googleSubject(account.owner, account.label))}`;
  }

  // Connect bills per token request and its SDK caches only per instance, so each token is shared
  // across instances for its lifetime less a margin. getToken never starts a sign-in, so a
  // background turn with no grant fails here instead of waiting on the owner.
  async function accessToken(account: Account, fresh: boolean): Promise<string> {
    const key = tokenCacheKey(account);
    if (fresh) await tokenCache.delete(key);
    else {
      const cached = await tokenCache.get(key);
      if (typeof cached === "string" && cached) return cached;
    }
    try {
      const { token, expiresAt } = await connect.getToken(
        connectorFor(account.owner).connector,
        tokenParams(account),
        fresh ? { forceRefresh: true } : undefined,
      );
      const ttlSeconds = (expiresAt - Date.now()) / 1000 - tokenCacheMarginSeconds;
      if (ttlSeconds >= 60) await tokenCache.set(key, token, ttlSeconds);
      return token;
    } catch (error) {
      if (error instanceof UserAuthorizationRequiredError || error instanceof NoValidTokenError) {
        throw new GoogleNeedsConnectingError(account.label, "is not connected, or its access was revoked");
      }
      throw error;
    }
  }

  async function googleCall<T extends z.ZodType>(
    account: Account,
    url: URL,
    schema: T,
    call: GoogleCallOptions = {},
  ): Promise<z.infer<T>> {
    const { body, method = body === undefined ? "GET" : "POST", idempotent = true } = call;
    let token = await accessToken(account, false);
    for (let attempt = 0; ; attempt += 1) {
      const response = await request(
        url,
        body === undefined
          ? { method, headers: { Authorization: `Bearer ${token}` } }
          : {
              method,
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      if (response.ok) {
        const text = await response.text();
        return schema.parse(text ? JSON.parse(text) : {});
      }

      if (response.status === 401) {
        if (attempt > 0) {
          await tokenCache.delete(tokenCacheKey(account));
          throw new GoogleNeedsConnectingError(account.label, "rejected even a freshly refreshed token");
        }
        token = await accessToken(account, true);
        continue;
      }

      const detail = (await response.text().catch(() => "")).slice(0, 300);
      const rateLimited = response.status === 403 && /rateLimitExceeded/iu.test(detail);
      // A server error can hide a write that landed, so only a call safe to repeat is retried after one.
      const serverError = response.status >= 500 && idempotent;
      if (attempt === 0 && (response.status === 429 || serverError || rateLimited)) {
        await sleep(retryDelayMs);
        continue;
      }
      if (response.status === 403 && /insufficient/iu.test(detail)) {
        throw new GoogleNeedsConnectingError(account.label, "was connected without the permission this needs");
      }
      throw new GoogleApiError(
        `Google ${url.hostname}${url.pathname} failed with ${response.status}: ${detail}`,
        response.status,
      );
    }
  }

  async function accountsOf(owner: GoogleOwner | null, fresh = false): Promise<Account[]> {
    const caller = connectorFor(owner).owner;
    const records = await registry.list({ fresh });
    return records.map((record) => ({ label: record.label, owner: caller }));
  }

  async function someAccounts(owner: GoogleOwner | null): Promise<Account[]> {
    const accounts = await accountsOf(owner);
    if (!accounts.length) throw new NoGoogleAccountsError();
    return accounts;
  }

  function addressKey(account: Account): string {
    return `google-address:${JSON.stringify(googleSubject(account.owner, account.label))}`;
  }

  // Connect's SDK keeps its own per-process token cache, which only a revoke or a forced refresh
  // otherwise clears. Until the owner finishes consent the old grant still answers, so a read in
  // between can cache the old account again; listAccounts is what gets past that.
  async function forget(account: Account): Promise<void> {
    if (connector) connect.deleteTokenCacheEntry(connector, tokenParams(account));
    await Promise.all([addresses.delete(addressKey(account)), tokenCache.delete(tokenCacheKey(account))]);
  }

  async function addressOf(account: Account, fresh = false): Promise<string> {
    const key = addressKey(account);
    const cached = fresh ? null : await addresses.get(key);
    if (typeof cached === "string" && cached) return cached;
    const { email } = await googleCall(account, new URL(userinfoUrl), userinfoSchema);
    await addresses.set(key, email, addressTtlSeconds);
    return email;
  }

  async function withAddress(accounts: readonly Account[], address: string): Promise<Account | undefined> {
    const known = await Promise.all(
      accounts.map(async (account) => ({ account, address: await addressOf(account).catch(() => null) })),
    );
    return known.find((entry) => entry.address !== null && sameAddress(entry.address, address))?.account;
  }

  async function describeAccounts(accounts: readonly Account[]): Promise<string> {
    if (!accounts.length) return "none is connected yet";
    const named = await Promise.all(
      accounts.map(
        async (account) => `${account.label} (${await addressOf(account).catch(() => "not connected or unreachable")})`,
      ),
    );
    return named.join(", ");
  }

  // An account is named by its label or by its address. A name the cached list misses is looked up
  // once more against the store, since another instance may have just connected it.
  async function only(owner: GoogleOwner | null, name: string): Promise<Account> {
    const label = labelOf(name);
    let accounts: Account[] = [];
    for (const fresh of [false, true]) {
      accounts = await accountsOf(owner, fresh);
      const match =
        accounts.find((account) => account.label === label) ??
        (name.includes("@") ? await withAddress(accounts, name) : undefined);
      if (match) return match;
    }
    throw new Error(`${name} is not one of the user's Google accounts: ${await describeAccounts(accounts)}.`);
  }

  async function selected(owner: GoogleOwner | null, name?: string): Promise<Account[]> {
    return name === undefined ? someAccounts(owner) : [await only(owner, name)];
  }

  async function acrossAccounts<T>(
    owner: GoogleOwner | null,
    name: string | undefined,
    run: (account: Account) => Promise<Page<T>>,
  ): Promise<{ results: T[]; errors: AccountError[]; more: boolean }> {
    const outcomes = await Promise.all(
      (await selected(owner, name)).map(async (account) => {
        try {
          const page = await run(account);
          return { ...page, errors: page.errors ?? [] };
        } catch (error) {
          return { items: [], more: false, errors: [toAccountError(account.label, error)] };
        }
      }),
    );
    return {
      results: outcomes.flatMap((outcome) => outcome.items),
      errors: outcomes.flatMap((outcome) => outcome.errors),
      more: outcomes.some((outcome) => outcome.more),
    };
  }

  async function getMessage(
    account: Account,
    id: string,
    format: "metadata" | "full",
    metadataHeaders: readonly string[] = summaryHeaders,
  ) {
    const url = new URL(`${gmailBase}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", format);
    if (format === "metadata") {
      for (const name of metadataHeaders) url.searchParams.append("metadataHeaders", name);
    }
    return googleCall(account, url, messageSchema);
  }

  async function replyContext(account: Account, id: string) {
    const raw = await getMessage(account, id, "metadata", replyHeaders);
    const subject = header(raw.payload, "Subject");
    const messageId = header(raw.payload, "Message-ID");
    return {
      threadId: raw.threadId,
      subject: /^re:/iu.test(subject) ? subject : `Re: ${subject}`,
      sender: header(raw.payload, "Reply-To") || header(raw.payload, "From"),
      inReplyTo: messageId,
      references: [header(raw.payload, "References"), messageId].filter(Boolean).join(" "),
    };
  }

  async function draftsLink(account: Account): Promise<string> {
    const address = await addressOf(account).catch(() => "0");
    return `https://mail.google.com/mail/u/${encodeURIComponent(address)}/#drafts`;
  }

  function eventUrl(ref: EventRef): URL {
    return new URL(
      `${calendarBase}/calendars/${encodeURIComponent(ref.calendarId)}/events/${encodeURIComponent(ref.id)}`,
    );
  }

  function calendarOf(account: Account, calendarId: string) {
    return { id: calendarId, name: calendarId === "primary" ? account.label : calendarId };
  }

  // A message deleted between listing and fetching is left out rather than failing the rest.
  async function summaries(account: Account, ids: readonly string[]): Promise<EmailSummary[]> {
    const messages = await mapLimited(ids, metadataConcurrency, (id) =>
      getMessage(account, id, "metadata").catch((error: unknown) => {
        if (error instanceof GoogleApiError && error.status === 404) return null;
        throw error;
      }),
    );
    return messages.filter((message) => message !== null).map((message) => toSummary(account.label, message));
  }

  async function searchAccount(account: Account, query: string, max: number): Promise<Page<EmailSummary>> {
    const url = new URL(`${gmailBase}/messages`);
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(max));
    const list = await googleCall(account, url, messageListSchema);
    const ids = list.messages.slice(0, max).map((message) => message.id);
    return {
      items: await summaries(account, ids),
      more: list.nextPageToken !== undefined || list.messages.length > max,
    };
  }

  async function eventsInCalendar(
    account: Account,
    calendar: { id: string; name: string },
    range: { from: Date; to: Date },
    max: number,
  ): Promise<Page<CalendarEvent>> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    // A page can hold fewer events than asked for even when more exist, so only a missing
    // nextPageToken proves the range is complete.
    for (let page = 0; page < maxEventPages && events.length < max; page += 1) {
      const url = new URL(`${calendarBase}/calendars/${encodeURIComponent(calendar.id)}/events`);
      url.searchParams.set("timeMin", range.from.toISOString());
      url.searchParams.set("timeMax", range.to.toISOString());
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", String(eventPageSize));
      url.searchParams.set("timeZone", timeZone);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const list = await googleCall(account, url, eventListSchema);
      events.push(
        ...list.items
          .filter((event) => event.status !== "cancelled")
          .map((event) => toEvent(account.label, calendar, event)),
      );
      pageToken = list.nextPageToken;
      if (!pageToken) break;
    }
    return { items: events.slice(0, max), more: pageToken !== undefined || events.length > max };
  }

  async function calendarsOf(account: Account, primaryOnly: boolean) {
    if (primaryOnly) return [{ id: "primary", name: account.label, primary: true }];
    const list = await googleCall(account, new URL(`${calendarBase}/users/me/calendarList`), calendarListSchema);
    return list.items
      .filter((calendar) => calendar.primary || calendar.selected)
      .filter((calendar) => calendar.accessRole !== "freeBusyReader")
      .map((calendar) => ({
        id: calendar.id,
        name: calendar.summaryOverride ?? calendar.summary,
        primary: calendar.primary,
      }));
  }

  // A shared or subscribed calendar that fails should not hide the account's own events.
  async function eventsInAccount(
    account: Account,
    range: { from: Date; to: Date },
    primaryOnly: boolean,
    max: number,
  ): Promise<Page<CalendarEvent>> {
    const calendars = await calendarsOf(account, primaryOnly);
    const outcomes = await Promise.allSettled(
      calendars.map((calendar) => eventsInCalendar(account, calendar, range, max)),
    );
    const events: CalendarEvent[] = [];
    const errors: AccountError[] = [];
    let more = false;
    outcomes.forEach((outcome, index) => {
      const calendar = calendars[index];
      if (outcome.status === "fulfilled") {
        events.push(...outcome.value.items);
        more ||= outcome.value.more;
      } else if (calendar?.primary) {
        throw outcome.reason;
      } else {
        const error = toAccountError(account.label, outcome.reason);
        errors.push({ ...error, error: `calendar "${calendar?.name}" was skipped: ${error.error}` });
      }
    });
    return { items: events, more, errors };
  }

  return {
    get configured(): boolean {
      return connector !== undefined;
    },

    async accountNames(owner: GoogleOwner | null): Promise<string[]> {
      return (await accountsOf(owner)).map((account) => account.label);
    },

    // The owner checks a connect with this, so it asks Connect for a fresh token and Google for the
    // address, past every cache: a name reconnected to another Google account shows the new address.
    async listAccounts(owner: GoogleOwner | null): Promise<GoogleAccountInfo[]> {
      return Promise.all(
        (await accountsOf(owner)).map(async (account): Promise<GoogleAccountInfo> => {
          try {
            await accessToken(account, true);
            return { account: account.label, email: await addressOf(account, true), status: "connected" };
          } catch (error) {
            if (error instanceof GoogleNeedsConnectingError) {
              return { account: account.label, email: null, status: "needs_connecting" };
            }
            return { account: account.label, email: null, status: "error", error: errorMessage(error) };
          }
        }),
      );
    },

    // Only for the owner's direct chat: whoever opens the link connects their Google account as the
    // owner's. A new name is added to the list before the link exists, so the grant it creates is
    // never one Adam cannot see, and taken off again if no link comes of it; an existing name gets
    // a fresh link for the same subject.
    async signIn(owner: GoogleOwner | null, name: string): Promise<GoogleSignIn> {
      const caller = connectorFor(owner);
      const label = name.includes("@") ? (await only(owner, name)).label : normalizeAccountLabel(name);
      const account = { label, owner: caller.owner };
      const { added } = await registry.add(label);
      await forget(account);
      let started: Awaited<ReturnType<GoogleConnect["startAuthorization"]>>;
      try {
        started = await connect.startAuthorization(caller.connector, tokenParams(account));
      } catch (error) {
        if (added) await registry.remove(label).catch(() => undefined);
        throw error;
      }
      return {
        account: label,
        added,
        url: started.url,
        expiresAt: started.expiresAt ? new Date(started.expiresAt) : null,
      };
    },

    async findAccount(owner: GoogleOwner | null, name: string): Promise<{ account: string; email: string | null }> {
      const account = await only(owner, name);
      return { account: account.label, email: await addressOf(account).catch(() => null) };
    },

    // The grant is revoked before the name goes, so a failed revoke leaves the account listed and
    // the owner can try again rather than believing access is gone.
    async disconnect(owner: GoogleOwner | null, name: string): Promise<GoogleDisconnect> {
      const caller = connectorFor(owner);
      const account = await only(owner, name);
      let hadGrant = true;
      try {
        await connect.revokeToken(caller.connector, { subject: googleSubject(account.owner, account.label) });
      } catch (error) {
        if (!isMissingGrant(error)) {
          const reason = `Vercel Connect could not revoke it, so it is still connected: ${errorMessage(error)}`;
          return { disconnected: false, account: account.label, reason };
        }
        hadGrant = false;
      }
      await forget(account);
      try {
        await registry.remove(account.label);
      } catch (error) {
        const warning =
          `Its sign-in was revoked, but the name could not be taken off the list (${errorMessage(error)}), ` +
          "so it shows as needing connecting; disconnecting it again finishes the job.";
        return { disconnected: true, account: account.label, hadGrant, warning };
      }
      return { disconnected: true, account: account.label, hadGrant };
    },

    // Null only when every account answered or needs connecting; a transient failure throws, so a
    // caller can retry instead of treating the address as unknown.
    async accountWithAddress(owner: GoogleOwner | null, address: string): Promise<string | null> {
      let failure: unknown;
      for (const account of await accountsOf(owner)) {
        try {
          if (sameAddress(await addressOf(account), address)) return account.label;
        } catch (error) {
          if (!(error instanceof GoogleNeedsConnectingError)) failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
      return null;
    },

    async searchEmail(
      owner: GoogleOwner | null,
      query: string,
      options: { account?: string; max: number },
    ): Promise<AcrossAccounts<EmailSummary>> {
      const found = await acrossAccounts(owner, options.account, (account) =>
        searchAccount(account, query, options.max),
      );
      const sorted = found.results.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
      return {
        results: sorted.slice(0, options.max),
        errors: found.errors,
        truncated: found.more || sorted.length > options.max,
      };
    },

    async readEmail(owner: GoogleOwner | null, name: string, id: string): Promise<Email> {
      const account = await only(owner, name);
      const raw = await getMessage(account, id, "full");
      const body = emailBody(raw.payload);
      const { text, truncated } = truncate(body.text, maxBodyChars);
      return {
        ...toSummary(account.label, raw),
        cc: header(raw.payload, "Cc"),
        body: text,
        truncated,
        attachments: body.attachments,
      };
    },

    async emailSummaries(owner: GoogleOwner | null, name: string, ids: readonly string[]): Promise<EmailSummary[]> {
      return summaries(await only(owner, name), ids);
    },

    async listEvents(
      owner: GoogleOwner | null,
      range: { from: Date; to: Date },
      options: { account?: string; primaryOnly: boolean; max: number },
    ): Promise<AcrossAccounts<CalendarEvent>> {
      const found = await acrossAccounts(owner, options.account, (account) =>
        eventsInAccount(account, range, options.primaryOnly, options.max),
      );
      const sorted = found.results.sort((a, b) => eventSortKey(a.start) - eventSortKey(b.start));
      return {
        results: sorted.slice(0, options.max),
        errors: found.errors,
        truncated: found.more || sorted.length > options.max,
      };
    },

    // A draft never sends: the owner reviews it and sends it from Gmail.
    async createDraft(owner: GoogleOwner | null, name: string, draft: DraftRequest): Promise<EmailDraft> {
      const account = await only(owner, name);
      const reply = draft.replyTo ? await replyContext(account, draft.replyTo) : null;
      const to = draft.to.length || !reply?.sender ? draft.to : [reply.sender];
      const subject = reply?.subject ?? draft.subject ?? "";
      const raw = composeEmail({
        to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject,
        body: draft.body,
        inReplyTo: reply?.inReplyTo,
        references: reply?.references,
      });
      const created = await googleCall(account, new URL(`${gmailBase}/drafts`), draftSchema, {
        body: { message: { raw: Buffer.from(raw).toString("base64url"), threadId: reply?.threadId } },
        idempotent: false,
      });
      return {
        account: account.label,
        id: created.id,
        threadId: created.message.threadId,
        to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject,
        link: await draftsLink(account),
      };
    },

    async getEvent(owner: GoogleOwner | null, name: string, ref: EventRef): Promise<CalendarEvent> {
      const account = await only(owner, name);
      const raw = await googleCall(account, eventUrl(ref), eventSchema);
      return toEvent(account.label, calendarOf(account, ref.calendarId), raw);
    },

    // Attendees get Google's invitation email; an event with none notifies nobody.
    async createEvent(owner: GoogleOwner | null, name: string, event: NewEvent): Promise<CalendarEvent> {
      checkEventSpan(event.start, event.end);
      const account = await only(owner, name);
      const url = new URL(`${calendarBase}/calendars/primary/events`);
      url.searchParams.set("sendUpdates", event.attendees.length ? "all" : "none");
      if (event.meet) url.searchParams.set("conferenceDataVersion", "1");
      const created = await googleCall(account, url, eventSchema, {
        body: {
          summary: event.title,
          location: event.location || undefined,
          description: event.description || undefined,
          start: toGoogleTime(event.start, timeZone),
          end: toGoogleEnd(event.end, timeZone),
          attendees: event.attendees.map((email) => ({ email })),
          conferenceData: event.meet
            ? { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } }
            : undefined,
        },
        idempotent: false,
      });
      return toEvent(account.label, calendarOf(account, "primary"), created);
    },

    async updateEvent(
      owner: GoogleOwner | null,
      name: string,
      ref: EventRef,
      changes: EventChanges,
    ): Promise<CalendarEvent> {
      const account = await only(owner, name);
      const current = await googleCall(account, eventUrl(ref), eventSchema);
      const currentStart = toEventTime(current.start);
      const start = changes.start ?? currentStart;
      const end = changes.end ?? toEventEnd(currentStart, current.end);
      checkEventSpan(start, end);
      const changesAttendees = Boolean(changes.addAttendees?.length || changes.removeAttendees?.length);
      const attendees = changesAttendees
        ? mergeAttendees(current.attendees, changes.addAttendees ?? [], changes.removeAttendees ?? [])
        : undefined;
      const url = eventUrl(ref);
      url.searchParams.set("sendUpdates", (attendees ?? current.attendees).length ? "all" : "none");
      const updated = await googleCall(account, url, eventSchema, {
        method: "PATCH",
        body: {
          summary: changes.title,
          location: changes.location,
          description: changes.description,
          start: toGoogleTime(start, timeZone),
          end: toGoogleEnd(end, timeZone),
          attendees,
        },
      });
      return toEvent(account.label, calendarOf(account, ref.calendarId), updated);
    },

    // Without a sync token this lists every event the calendar has, which is what gives the first
    // token. A token Google no longer honours fails with a GoogleApiError of status 410.
    async calendarChanges(
      owner: GoogleOwner | null,
      name: string,
      calendarId: string,
      cursor: { readonly syncToken: string | null; readonly pageToken?: string },
    ): Promise<CalendarChangesPage> {
      const account = await only(owner, name);
      const url = new URL(`${calendarBase}/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set("maxResults", String(changesPageSize));
      url.searchParams.set("fields", changeFields);
      url.searchParams.set("timeZone", timeZone);
      if (cursor.syncToken) url.searchParams.set("syncToken", cursor.syncToken);
      if (cursor.pageToken) url.searchParams.set("pageToken", cursor.pageToken);
      const page = await googleCall(account, url, changesSchema);
      const calendar = calendarOf(account, calendarId);
      return {
        revisions: page.items.map((raw) => toRevision(account.label, calendar, raw)),
        nextPageToken: page.nextPageToken ?? null,
        nextSyncToken: page.nextSyncToken ?? null,
      };
    },

    // Google posts to `address` on every change to an ordinary event, echoing `token`, until the
    // channel expires or is stopped; it never renews one.
    async watchCalendar(owner: GoogleOwner | null, name: string, watch: CalendarWatchRequest): Promise<CalendarWatch> {
      const url = new URL(`${calendarBase}/calendars/${encodeURIComponent(watch.calendarId)}/events/watch`);
      url.searchParams.set("eventTypes", "default");
      const channel = await googleCall(await only(owner, name), url, channelSchema, {
        body: {
          id: watch.channelId,
          type: "web_hook",
          address: watch.address,
          token: watch.token,
          params: { ttl: String(watch.ttlSeconds) },
        },
      });
      const expiresAt = channel.expiration === undefined ? Date.now() + watch.ttlSeconds * 1000 : Number(channel.expiration);
      return { channelId: channel.id, resourceId: channel.resourceId, expiresAt: new Date(expiresAt) };
    },

    // Only the user who opened a channel, through the same OAuth client, can stop it.
    async stopCalendarWatch(
      owner: GoogleOwner | null,
      name: string,
      channel: { readonly channelId: string; readonly resourceId: string },
    ): Promise<void> {
      await googleCall(await only(owner, name), new URL(`${calendarBase}/channels/stop`), z.unknown(), {
        body: { id: channel.channelId, resourceId: channel.resourceId },
      });
    },

    // Gmail stops pushing to the topic after seven days unless the watch is renewed.
    async stopMailboxWatch(owner: GoogleOwner | null, name: string): Promise<void> {
      await googleCall(await only(owner, name), new URL(`${gmailBase}/stop`), z.unknown(), { body: {} });
    },

    async watchMailbox(owner: GoogleOwner | null, name: string, topicName: string): Promise<MailboxWatch> {
      const watch = await googleCall(await only(owner, name), new URL(`${gmailBase}/watch`), watchSchema, {
        body: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "include" },
      });
      return { historyId: watch.historyId, expiresAt: new Date(Number(watch.expiration)) };
    },

    // Uncached: the mailbox the account's token reads right now, and where its history stands.
    async mailboxProfile(owner: GoogleOwner | null, name: string): Promise<{ emailAddress: string; historyId: string }> {
      return googleCall(await only(owner, name), new URL(`${gmailBase}/profile`), profileSchema);
    },

    // A startHistoryId too old for Gmail to replay fails with a GoogleApiError of status 404.
    async mailboxHistory(
      owner: GoogleOwner | null,
      name: string,
      startHistoryId: string,
      pageToken?: string,
    ): Promise<MailboxHistory> {
      const url = new URL(`${gmailBase}/history`);
      url.searchParams.set("startHistoryId", startHistoryId);
      url.searchParams.set("historyTypes", "messageAdded");
      url.searchParams.set("labelId", "INBOX");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const history = await googleCall(await only(owner, name), url, historySchema);
      const ids = history.history.flatMap((entry) => entry.messagesAdded.map((added) => added.message.id));
      return {
        addedMessageIds: [...new Set(ids)],
        historyId: history.historyId,
        nextPageToken: history.nextPageToken ?? null,
      };
    },
  };
}

export type GoogleWorkspace = ReturnType<typeof googleWorkspace>;

// Every mail push maps its address through the account list, so the list lives in Runtime Cache,
// shared by every instance and refreshed on each connect and disconnect; the hour only bounds how
// long a refresh that failed to land can linger.
const accountListTtlSeconds = 60 * 60;

export const google = googleWorkspace({
  connector: env.GOOGLE_CONNECTOR,
  accounts: googleAccountRegistry({
    store: blobGoogleAccountStore,
    cache: secretCache,
    cacheTtlSeconds: accountListTtlSeconds,
  }),
  addressCache: secretCache,
  timeZone: env.USER_TIMEZONE,
});
