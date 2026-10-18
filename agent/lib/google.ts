import {
  getToken,
  NoValidTokenError,
  startAuthorization,
  UserAuthorizationRequiredError,
  type ConnectTokenParams,
} from "@vercel/connect";
import { z } from "zod";

import { env, type GoogleConnector } from "#lib/env.js";
import type { HomeOwner } from "#lib/home-target.js";
import { startOfLocalDay } from "#lib/zoned-time.js";

const userinfoUrl = "https://openidconnect.googleapis.com/v1/userinfo";
const gmailBase = "https://gmail.googleapis.com/gmail/v1/users/me";
const calendarBase = "https://www.googleapis.com/calendar/v3";

const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const calendarScope = "https://www.googleapis.com/auth/calendar.readonly";
export const googleScopes = ["openid", "email", gmailScope, calendarScope] as const;

const retryDelayMs = 500;
const maxBodyChars = 8000;
const maxDescriptionChars = 1500;
const eventPageSize = 100;
const maxEventPages = 3;
const metadataConcurrency = 5;

// The slice of @vercel/connect this file uses, so tests can stand in for Vercel Connect.
export interface GoogleConnect {
  getToken(connector: string, params: ConnectTokenParams, options?: { forceRefresh?: boolean }): Promise<string>;
  startAuthorization(connector: string, params: ConnectTokenParams): Promise<{ url: string; expiresAt?: number }>;
}

const vercelConnect: GoogleConnect = {
  getToken: (connector, params, options) => getToken(connector, params, options),
  startAuthorization: (connector, params) => startAuthorization(connector, params),
};

export class GoogleNotConfiguredError extends Error {
  constructor() {
    super("Google isn't configured: set GOOGLE_CONNECTORS to one Vercel Connect connector per account.");
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
  readonly url: string;
  readonly expiresAt: Date | null;
}

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
}

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

const eventListSchema = z.object({
  items: z.array(eventSchema).default([]),
  nextPageToken: z.string().optional(),
});


const userinfoSchema = z.object({ email: z.string() });

const watchSchema = z.object({ historyId: z.string(), expiration: z.string() });

const historySchema = z.object({
  history: z
    .array(z.object({ messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).default([]) }))
    .default([]),
  historyId: z.string(),
  nextPageToken: z.string().optional(),
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
  };
}

function toEventTime(time: z.infer<typeof eventTimeSchema>): EventTime {
  if (time.dateTime) return { allDay: false, at: new Date(time.dateTime) };
  return { allDay: true, date: time.date ?? "" };
}

function previousDay(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(parsed) ? date : new Date(parsed - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Google's all-day end date is exclusive; the domain's is the last day the event covers.
function toEventEnd(start: EventTime, end: z.infer<typeof eventTimeSchema>): EventTime {
  const time = toEventTime(end);
  if (!time.allDay || !start.allDay) return time;
  const last = previousDay(time.date);
  return { allDay: true, date: last < start.date ? start.date : last };
}

function person(raw: z.infer<typeof personSchema> | undefined): string {
  if (!raw) return "";
  if (raw.displayName && raw.email) return `${raw.displayName} <${raw.email}>`;
  return raw.displayName ?? raw.email ?? "";
}

function toEvent(account: string, calendar: string, raw: z.infer<typeof eventSchema>): CalendarEvent {
  return {
    account,
    calendar,
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

interface Account extends GoogleConnector {
  readonly owner: GoogleOwner;
}

export interface GoogleWorkspaceDeps {
  readonly connectors: readonly GoogleConnector[];
  readonly timeZone: string;
  readonly connect?: GoogleConnect;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function googleWorkspace(deps: GoogleWorkspaceDeps) {
  const { connectors, timeZone } = deps;
  const connect = deps.connect ?? vercelConnect;
  const request = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const addresses = new Map<string, string>();

  function eventSortKey(time: EventTime): number {
    if (!time.allDay) return time.at.getTime();
    try {
      return startOfLocalDay(time.date, timeZone).getTime();
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  // The same subject Eve's connect() adapter derives from a user principal, so every Connect
  // grant the owner holds is keyed alike.
  function tokenParams(owner: GoogleOwner): ConnectTokenParams {
    return {
      subject: { type: "user", id: owner.principalId, issuer: owner.issuer },
      scopes: [...googleScopes],
    };
  }

  // getToken never starts a sign-in, so a background turn with no grant fails here instead of
  // waiting on the owner.
  async function accessToken(account: Account, fresh: boolean): Promise<string> {
    try {
      return await connect.getToken(
        account.connector,
        tokenParams(account.owner),
        fresh ? { forceRefresh: true } : undefined,
      );
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
    body?: unknown,
  ): Promise<z.infer<T>> {
    let token = await accessToken(account, false);
    for (let attempt = 0; ; attempt += 1) {
      const response = await request(
        url,
        body === undefined
          ? { headers: { Authorization: `Bearer ${token}` } }
          : {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      if (response.ok) return schema.parse(await response.json());

      if (response.status === 401) {
        if (attempt > 0) throw new GoogleNeedsConnectingError(account.label, "rejected even a freshly refreshed token");
        token = await accessToken(account, true);
        continue;
      }

      const detail = (await response.text().catch(() => "")).slice(0, 300);
      const rateLimited = response.status === 403 && /rateLimitExceeded/iu.test(detail);
      if (attempt === 0 && (response.status === 429 || response.status >= 500 || rateLimited)) {
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

  function accountsOf(owner: GoogleOwner | null): Account[] {
    if (!connectors.length) throw new GoogleNotConfiguredError();
    if (!owner) {
      throw new Error("Google accounts belong to the user, and this turn carries no user identity to read them as.");
    }
    return connectors.map((connector) => ({ ...connector, owner }));
  }

  async function addressOf(account: Account): Promise<string> {
    const cached = addresses.get(account.connector);
    if (cached) return cached;
    const { email } = await googleCall(account, new URL(userinfoUrl), userinfoSchema);
    addresses.set(account.connector, email);
    return email;
  }

  // An account is named by its label from GOOGLE_CONNECTORS or by its address.
  async function selected(owner: GoogleOwner | null, name?: string): Promise<Account[]> {
    const accounts = accountsOf(owner);
    if (name === undefined) return accounts;
    const labelled = accounts.find((account) => account.label === name.trim().toLowerCase());
    if (labelled) return [labelled];
    const known = await Promise.all(
      accounts.map(async (account) => ({ account, address: await addressOf(account).catch(() => null) })),
    );
    const match = known.find(({ address }) => address !== null && sameAddress(address, name));
    if (match) return [match.account];
    const names = known
      .map(({ account, address }) => `${account.label} (${address ?? "not connected or unreachable"})`)
      .join(", ");
    throw new Error(`${name} is not one of the user's Google accounts: ${names}.`);
  }

  async function only(owner: GoogleOwner | null, name: string): Promise<Account> {
    const [account] = await selected(owner, name);
    if (!account) throw new Error(`${name} is not one of the user's Google accounts.`);
    return account;
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

  async function getMessage(account: Account, id: string, format: "metadata" | "full") {
    const url = new URL(`${gmailBase}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", format);
    if (format === "metadata") {
      for (const name of ["From", "To", "Subject", "Date"]) url.searchParams.append("metadataHeaders", name);
    }
    return googleCall(account, url, messageSchema);
  }

  async function summaries(account: Account, ids: readonly string[]): Promise<EmailSummary[]> {
    const messages = await mapLimited(ids, metadataConcurrency, (id) => getMessage(account, id, "metadata"));
    return messages.map((message) => toSummary(account.label, message));
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
          .map((event) => toEvent(account.label, calendar.name, event)),
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
      return connectors.length > 0;
    },

    async listAccounts(owner: GoogleOwner | null): Promise<GoogleAccountInfo[]> {
      return Promise.all(
        accountsOf(owner).map(async (account): Promise<GoogleAccountInfo> => {
          try {
            await accessToken(account, false);
            return { account: account.label, email: await addressOf(account), status: "connected" };
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
    // owner's.
    async signIn(owner: GoogleOwner | null, name?: string): Promise<GoogleSignIn> {
      const accounts = accountsOf(owner);
      const labels = accounts.map((account) => account.label).join(", ");
      const target = name === undefined ? (accounts.length === 1 ? accounts[0] : undefined) : await only(owner, name);
      if (!target) throw new Error(`Ask which account to connect: ${labels}.`);
      addresses.delete(target.connector);
      const started = await connect.startAuthorization(target.connector, tokenParams(target.owner));
      return {
        account: target.label,
        url: started.url,
        expiresAt: started.expiresAt ? new Date(started.expiresAt) : null,
      };
    },

    async accountWithAddress(owner: GoogleOwner | null, address: string): Promise<string | null> {
      for (const account of accountsOf(owner)) {
        const known = await addressOf(account).catch(() => null);
        if (known !== null && sameAddress(known, address)) return account.label;
      }
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

    // Gmail stops pushing to the topic after seven days unless the watch is renewed.
    async watchMailbox(owner: GoogleOwner | null, name: string, topicName: string): Promise<MailboxWatch> {
      const watch = await googleCall(await only(owner, name), new URL(`${gmailBase}/watch`), watchSchema, {
        topicName,
        labelIds: ["INBOX"],
        labelFilterBehavior: "include",
      });
      return { historyId: watch.historyId, expiresAt: new Date(Number(watch.expiration)) };
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

export const google = googleWorkspace({ connectors: env.GOOGLE_CONNECTORS, timeZone: env.USER_TIMEZONE });
