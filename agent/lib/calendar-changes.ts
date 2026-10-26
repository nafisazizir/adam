import { createHash, randomUUID } from "node:crypto";

import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

import type { CalendarChannelTokens } from "#lib/calendar-push.js";
import { coalescedRun, takeDailyRun, type CoalescedRun } from "#lib/coalesce.js";
import {
  GoogleApiError,
  GoogleNeedsConnectingError,
  type CalendarChangesPage,
  type CalendarEvent,
  type CalendarWatch,
  type CalendarWatchRequest,
  type EventRevision,
  type EventTime,
} from "#lib/google.js";
import type { HomeOwner } from "#lib/home-target.js";
import { describeSpan, describeTime } from "#lib/inbox-view.js";
import type { WatchOutcome } from "#lib/new-mail.js";
import { ownerAuth } from "#lib/owner.js";
import type { SharedCache } from "#lib/shared-cache.js";
import { formatUserTime, userLocalDate } from "#lib/time.js";
import { untrusted } from "#lib/untrusted.js";

export const calendarAuthenticator = "calendar";

const minuteMs = 60 * 1000;
const dayMs = 24 * 60 * minuteMs;
const coalesceWindowMs = 5 * minuteMs;
export const dailyCalendarRunCap = 60;
const maxChangePages = 5;
const maxBaselinePages = 10;
export const maxTrackedEvents = 400;
export const maxChangesPerTrigger = 10;
const maxAttendeesShown = 10;
const cursorTtlSeconds = 30 * 24 * 60 * 60;
const toldTtlSeconds = 3 * 24 * 60 * 60;
export const channelTtlSeconds = 7 * 24 * 60 * 60;
export const renewAheadMs = 2 * dayMs;
export const staleChannelTtlSeconds = channelTtlSeconds;
const pastGraceMs = dayMs;

export const calendarRunSchema = z.object({
  account: z.string().min(1),
  calendarId: z.string().min(1),
  channelId: z.string().min(1),
});

export type CalendarRun = z.infer<typeof calendarRunSchema>;

// Google posts on every change to the calendar, the owner's own included, so a burst of edits is one run.
export function coalescedCalendarRun(run: CalendarRun, now: Date = new Date()): CoalescedRun<CalendarRun> {
  const source = `${run.account}-${run.calendarId}`;
  return coalescedRun({ prefix: "calendar", source, body: run, windowMs: coalesceWindowMs, now });
}

export function takeDailyCalendarRun(cache: SharedCache, run: CalendarRun, day: string): Promise<boolean> {
  const key = `calendar-runs:${run.account}:${run.calendarId}`;
  return takeDailyRun(cache, { key, day, cap: dailyCalendarRunCap, label: "calendar" });
}

// What Adam last saw of an event, enough to tell what changed and so who changed it. Places and
// guests are hashed: they only need comparing.
const fingerprintSchema = z.object({
  series: z.boolean().default(false),
  start: z.string(),
  end: z.string(),
  place: z.string(),
  response: z.string().nullable(),
  declined: z.array(z.string()),
});

type Fingerprint = z.infer<typeof fingerprintSchema>;

export type CalendarSnapshot = Readonly<Record<string, Fingerprint>>;

function timeKey(time: EventTime): string {
  return time.allDay ? time.date : time.at.toISOString();
}

function timeFromKey(key: string): EventTime {
  return /^\d{4}-\d{2}-\d{2}$/u.test(key) ? { allDay: true, date: key } : { allDay: false, at: new Date(key) };
}

function startsAt(time: EventTime): number {
  return time.allDay ? Date.parse(`${time.date}T00:00:00Z`) : time.at.getTime();
}

// An all-day end is its last day, taken as ending at UTC midnight after it.
function endsAt(time: EventTime): number {
  return time.allDay ? Date.parse(`${time.date}T23:59:59Z`) : time.at.getTime();
}

function digest(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase()).digest("base64url").slice(0, 12);
}

type Seen = EventRevision & { readonly event: CalendarEvent };

function seen(revision: EventRevision): revision is Seen {
  return revision.event !== null;
}

// A series' own times are its first occurrence, so only its rules say whether it has ended.
function isLive(revision: Seen, now: number, graceMs: number): boolean {
  if (revision.recurring) return !revision.seriesUntil || revision.seriesUntil.getTime() >= now - graceMs;
  return endsAt(revision.event.end) >= now - graceMs;
}

function fingerprintOf(revision: Seen): Fingerprint {
  const { event } = revision;
  return {
    series: revision.recurring,
    start: timeKey(event.start),
    end: timeKey(event.end),
    place: digest(event.location),
    response: event.myResponse,
    declined: revision.declinedBy.map((guest) => digest(guest.address)),
  };
}

function tracked(revision: EventRevision, now: number): revision is Seen {
  return seen(revision) && !revision.cancelled && revision.ordinary && isLive(revision, now, pastGraceMs);
}

// Live series first, then the soonest events, so the cap drops what lies furthest out.
function relevance(fingerprint: Fingerprint): number {
  return fingerprint.series ? Number.NEGATIVE_INFINITY : startsAt(timeFromKey(fingerprint.start));
}

export function applyRevisions(
  snapshot: CalendarSnapshot,
  revisions: readonly EventRevision[],
  now: number,
): Record<string, Fingerprint> {
  const next: Record<string, Fingerprint> = { ...snapshot };
  for (const revision of revisions) {
    delete next[revision.id];
    if (tracked(revision, now)) next[revision.id] = fingerprintOf(revision);
  }
  const kept = Object.entries(next).sort(([, a], [, b]) => relevance(a) - relevance(b));
  return Object.fromEntries(kept.slice(0, maxTrackedEvents));
}

export interface EventSpan {
  readonly start: EventTime;
  readonly end: EventTime | null;
}

interface ChangeBase {
  readonly event: CalendarEvent;
  readonly updated: string;
  // The event is a whole recurring series, whose times are its first occurrence.
  readonly series: boolean;
}

export type CalendarChange =
  | (ChangeBase & { readonly kind: "invited" })
  | (ChangeBase & { readonly kind: "changed"; readonly time: boolean; readonly place: boolean; readonly was: EventSpan | null })
  | (ChangeBase & { readonly kind: "cancelled" })
  | (ChangeBase & { readonly kind: "declined"; readonly declinedBy: readonly string[] });

export interface ChangeContext {
  readonly snapshot: CalendarSnapshot;
  readonly now: number;
  // Every connected account's address, lowercased: an event any of them organises is the owner's.
  readonly ownerAddresses: ReadonlySet<string>;
}

// The Calendar API never says who made a change, so it is read off what changed. On an event this
// account organises, only a guest's reply is someone else's doing; the owner's edits, Adam's
// included, never count. One organised from another of the owner's accounts never counts here:
// that account's copy tells of its guests. On one they were invited to, only the organiser moves
// or cancels it, while a reply is the owner's own. An event Adam never saw is new: an invitation if
// it is still unanswered, unless it is one occurrence of a series.
export function changeOf(revision: EventRevision, context: ChangeContext): CalendarChange | null {
  if (!revision.ordinary || !seen(revision) || !isLive(revision, context.now, 0)) return null;
  const { event, updated } = revision;
  const base = { event, updated, series: revision.recurring };
  const previous = context.snapshot[revision.id];

  if (revision.organizedByOwner) {
    if (revision.cancelled || !previous) return null;
    const before = new Set(previous.declined);
    const declinedBy = revision.declinedBy.filter((guest) => !before.has(digest(guest.address)));
    return declinedBy.length ? { ...base, kind: "declined", declinedBy: declinedBy.map((guest) => guest.label) } : null;
  }
  if (revision.organizer && context.ownerAddresses.has(revision.organizer)) return null;

  const known = previous ?? (revision.instanceOf ? context.snapshot[revision.instanceOf] : undefined);
  if (event.myResponse === "declined" || known?.response === "declined") return null;
  if (revision.cancelled) return known ? { ...base, kind: "cancelled" } : null;

  if (!previous) {
    const original = revision.originalStart;
    if (original && timeKey(original) !== timeKey(event.start)) {
      return { ...base, kind: "changed", time: true, place: false, was: { start: original, end: null } };
    }
    return !revision.instanceOf && event.myResponse === "needsAction" ? { ...base, kind: "invited" } : null;
  }

  const time = previous.start !== timeKey(event.start) || previous.end !== timeKey(event.end);
  const place = previous.place !== digest(event.location);
  if (!time && !place) return null;
  const was = time ? { start: timeFromKey(previous.start), end: timeFromKey(previous.end) } : null;
  return { ...base, kind: "changed", time, place, was };
}

// A series may meet today whenever it began.
function urgency(change: CalendarChange, now: number): number {
  const start = startsAt(change.event.start);
  return change.series ? Math.max(start, now) : start;
}

export function noteworthyChanges(revisions: readonly EventRevision[], context: ChangeContext): CalendarChange[] {
  return revisions
    .map((revision) => changeOf(revision, context))
    .filter((change) => change !== null)
    .sort((a, b) => urgency(a, context.now) - urgency(b, context.now))
    .slice(0, maxChangesPerTrigger);
}

function timesOfDay(start: EventTime, end: EventTime | null): string {
  if (start.allDay) return "all day";
  return end && !end.allDay ? `${formatUserTime(start.at)} to ${formatUserTime(end.at)}` : formatUserTime(start.at);
}

function describeWhen(change: CalendarChange, now: number): string {
  const { start, end } = change.event;
  if (!change.series) return describeSpan(start, end);
  const from = startsAt(start) > now ? `, from ${describeTime(start)}` : "";
  return `a recurring event, each time ${timesOfDay(start, end)}${from}`;
}

function describeWas(change: CalendarChange & { kind: "changed" }, was: EventSpan): string {
  if (!change.series) return was.end ? describeSpan(was.start, was.end) : describeTime(was.start);
  const days = userLocalDayOf(was.start) !== userLocalDayOf(change.event.start) ? ", on other days" : "";
  return `${timesOfDay(was.start, was.end)}${days}`;
}

function userLocalDayOf(time: EventTime): string {
  return time.allDay ? time.date : userLocalDate(time.at);
}

function headline(change: CalendarChange, now: number): string {
  const when = describeWhen(change, now);
  switch (change.kind) {
    case "invited":
      return `- New invitation, not answered yet: ${when}`;
    case "cancelled":
      return `- Cancelled by the organiser: was ${when}`;
    case "declined":
      return `- A guest declined an event the user organises: ${when}`;
    case "changed": {
      const what = [change.time ? "time" : null, change.place ? "place" : null].filter(Boolean).join(" and ");
      return `- The organiser changed its ${what}: now ${when}${change.was ? `, was ${describeWas(change, change.was)}` : ""}`;
    }
  }
}

function attendeesLine(attendees: readonly string[]): string | null {
  if (!attendees.length) return null;
  const shown = attendees.slice(0, maxAttendeesShown).join(", ");
  const more = attendees.length - maxAttendeesShown;
  return `Attendees: ${shown}${more > 0 ? ` and ${more} more` : ""}`;
}

function changeEntry(change: CalendarChange, now: number): string {
  const { event } = change;
  const content = untrusted(
    "calendar_content",
    { account: event.account, id: event.id },
    [
      `Title: ${event.title || "(untitled)"}`,
      event.location ? `Location: ${event.location}` : null,
      event.organizer ? `Organizer: ${event.organizer}` : null,
      attendeesLine(event.attendees),
      change.kind === "declined" ? `Declined: ${change.declinedBy.join(", ")}` : null,
    ],
    ["calendar_change"],
  );
  return [headline(change, now), content].join("\n");
}

// The account is a label, which normalizeAccountLabel limits to [a-z0-9-].
export function calendarChangeMessage(
  account: string,
  changes: readonly CalendarChange[],
  timeContext: string,
  now: number = Date.now(),
): string {
  return [
    timeContext,
    "",
    `<calendar_change account="${account}">`,
    "Events on the user's calendar changed because of someone else. Nobody asked for this message; decide whether any of it is worth a text.",
    "",
    changes.map((change) => changeEntry(change, now)).join("\n\n"),
    "</calendar_change>",
    "",
    "Follow your calendar change rules: if a change here upsets the user's plans soon, text them in one short message; if nothing does, call the stay_silent tool.",
  ].join("\n");
}

export function calendarAuth(owner: HomeOwner, account: string): SessionAuthContext {
  return ownerAuth(owner, { authenticator: calendarAuthenticator, attributes: { account } });
}

// Calendar state is only a cache entry, never Blob: a lost cursor costs a silent re-sync, and at
// worst the heads-up for the change that found it missing.
const cursorSchema = z.object({
  syncToken: z.string().min(1),
  events: z.record(z.string(), fingerprintSchema),
  syncedAt: z.number(),
});

type Cursor = z.infer<typeof cursorSchema>;

const channelRecordSchema = z.object({
  channelId: z.string(),
  resourceId: z.string(),
  expiresAt: z.number(),
});

export type ChannelRecord = z.infer<typeof channelRecordSchema>;

const cursorKey = (account: string, calendarId: string) => `calendar-cursor:${account}:${calendarId}`;
const channelKey = (account: string, calendarId: string) => `calendar-channel:${account}:${calendarId}`;
const toldKey = (account: string, calendarId: string, change: CalendarChange) =>
  `calendar-told:${account}:${calendarId}:${change.event.id}:${change.updated}`;
export const staleChannelKey = (channelId: string) => `calendar-stale:${channelId}`;
// Adam's own writes are not tied to a version of the event, so the marker covers the event briefly.
const ownEditKey = (account: string, eventId: string) => `calendar-own-edit:${account}:${eventId}`;
const ownEditTtlSeconds = 30 * 60;

// For an event Adam itself just changed: a run in the next half hour takes it as the owner's doing,
// which covers an invitation whose guests may edit it, where the change looks like the organiser's.
export async function noteOwnEdit(cache: SharedCache, account: string, eventId: string): Promise<void> {
  await cache.set(ownEditKey(account, eventId), true, ownEditTtlSeconds);
}

export interface CalendarReader {
  changes(cursor: { readonly syncToken: string | null; readonly pageToken?: string }): Promise<CalendarChangesPage>;
}

async function readCursor(cache: SharedCache, account: string, calendarId: string): Promise<Cursor | null> {
  const parsed = cursorSchema.safeParse(await cache.get(cursorKey(account, calendarId)));
  return parsed.success ? parsed.data : null;
}

async function readChannel(cache: SharedCache, account: string, calendarId: string): Promise<ChannelRecord | null> {
  const parsed = channelRecordSchema.safeParse(await cache.get(channelKey(account, calendarId)));
  return parsed.success ? parsed.data : null;
}

// Null when the changes run past what one run reads.
async function readAll(reader: CalendarReader, syncToken: string | null, maxPages: number) {
  const revisions: EventRevision[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await reader.changes(pageToken ? { syncToken, pageToken } : { syncToken });
    revisions.push(...result.revisions);
    if (result.nextSyncToken) return { revisions, syncToken: result.nextSyncToken };
    if (!result.nextPageToken) throw new Error("Google ended a calendar sync without a sync token");
    pageToken = result.nextPageToken;
  }
  return null;
}

interface CalendarTarget {
  readonly cache: SharedCache;
  readonly account: string;
  readonly calendarId: string;
  readonly reader: CalendarReader;
}

async function writeCursor(target: CalendarTarget, cursor: Cursor): Promise<void> {
  await target.cache.set(cursorKey(target.account, target.calendarId), cursor, cursorTtlSeconds);
}

// Retrying cannot help, so a run acknowledges it rather than spending QStash retries on it.
export class CalendarTooLargeError extends Error {}

// Everything already on the calendar is taken as known, so it never triggers.
async function resync(target: CalendarTarget, now: number): Promise<void> {
  const all = await readAll(target.reader, null, maxBaselinePages);
  if (!all) throw new CalendarTooLargeError(`the ${target.account} calendar has more events than Adam can sync`);
  await writeCursor(target, { syncToken: all.syncToken, events: applyRevisions({}, all.revisions, now), syncedAt: now });
}

function isExpiredToken(error: unknown): boolean {
  return error instanceof GoogleApiError && error.status === 410;
}

export type CalendarRunOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "reset" }
  | { readonly kind: "quiet"; readonly checked: number }
  | { readonly kind: "delivered"; readonly count: number };

export interface CalendarRunDeps {
  readonly cache: SharedCache;
  readonly reader: CalendarReader;
  readonly now?: () => number;
  ownerAddresses(): Promise<readonly string[]>;
  deliver(changes: readonly CalendarChange[]): Promise<void>;
}

// Each change is told once per version of its event: the marker goes down before delivery and
// comes off again if delivery fails, so a QStash retry resends it, and the cursor moves only after.
export async function processCalendar(run: CalendarRun, deps: CalendarRunDeps): Promise<CalendarRunOutcome> {
  const { cache } = deps;
  const target: CalendarTarget = { cache, account: run.account, calendarId: run.calendarId, reader: deps.reader };
  const now = (deps.now ?? Date.now)();

  const cursor = await readCursor(cache, run.account, run.calendarId);
  if (!cursor) {
    await resync(target, now);
    return { kind: "started" };
  }

  let read: Awaited<ReturnType<typeof readAll>>;
  try {
    read = await readAll(deps.reader, cursor.syncToken, maxChangePages);
  } catch (error) {
    if (!isExpiredToken(error)) throw error;
    await resync(target, now);
    return { kind: "reset" };
  }
  if (!read) {
    console.warn(`[calendar] ${run.account} changed more than a run reads; syncing it again without telling`);
    await resync(target, now);
    return { kind: "reset" };
  }

  const ownerAddresses = new Set(read.revisions.length ? await deps.ownerAddresses() : []);
  const found = noteworthyChanges(read.revisions, { snapshot: cursor.events, now, ownerAddresses });
  const skipped = await Promise.all(
    found.map(
      async (change) =>
        Boolean(await cache.get(toldKey(run.account, run.calendarId, change))) ||
        Boolean(await cache.get(ownEditKey(run.account, change.event.id))),
    ),
  );
  const fresh = found.filter((_, index) => !skipped[index]);

  if (fresh.length) {
    const keys = fresh.map((change) => toldKey(run.account, run.calendarId, change));
    await Promise.all(keys.map((key) => cache.set(key, true, toldTtlSeconds)));
    try {
      await deps.deliver(fresh);
    } catch (error) {
      await Promise.all(keys.map((key) => cache.delete(key)));
      throw error;
    }
  }

  await writeCursor(target, {
    syncToken: read.syncToken,
    events: applyRevisions(cursor.events, read.revisions, now),
    syncedAt: now,
  });
  return fresh.length ? { kind: "delivered", count: fresh.length } : { kind: "quiet", checked: read.revisions.length };
}

export interface CalendarWatchDeps {
  readonly cache: SharedCache;
  readonly calendarId: string;
  readonly address: string;
  readonly tokens: CalendarChannelTokens;
  readonly now?: () => number;
  readonly newChannelId?: () => string;
  reader(account: string): CalendarReader;
  watch(account: string, request: CalendarWatchRequest): Promise<CalendarWatch>;
  stop(account: string, channel: ChannelRecord): Promise<void>;
}

// Google never renews a channel, so a new one opens when the last is within two days of expiring
// (or unknown), and the old one is stopped after. A calendar is synced before its first channel
// opens, so the first push already has something to compare with.
export async function renewCalendarWatches(
  accounts: readonly string[],
  deps: CalendarWatchDeps,
): Promise<Record<string, WatchOutcome>> {
  const outcomes: Record<string, WatchOutcome> = {};
  const { cache, calendarId } = deps;
  for (const account of accounts) {
    try {
      const now = (deps.now ?? Date.now)();
      const target: CalendarTarget = { cache, account, calendarId, reader: deps.reader(account) };
      if (!(await readCursor(cache, account, calendarId))) await resync(target, now);

      const current = await readChannel(cache, account, calendarId);
      if (current && current.expiresAt - now > renewAheadMs) {
        outcomes[account] = "watching";
        continue;
      }

      const channelId = (deps.newChannelId ?? randomUUID)();
      const watch = await deps.watch(account, {
        calendarId,
        channelId,
        address: deps.address,
        token: deps.tokens.sign(channelId, { account, calendarId }, new Date(now + channelTtlSeconds * 1000)),
        ttlSeconds: channelTtlSeconds,
      });
      const record: ChannelRecord = {
        channelId: watch.channelId,
        resourceId: watch.resourceId,
        expiresAt: watch.expiresAt.getTime(),
      };
      const recordSeconds = (record.expiresAt - now) / 1000;
      if (recordSeconds >= 60) await cache.set(channelKey(account, calendarId), record, recordSeconds);
      if (current) {
        await deps.stop(account, current).catch((error: unknown) => {
          console.warn(`[calendar] could not stop the old channel on ${account}; it lapses on its own`, error);
        });
      }
      outcomes[account] = "started";
    } catch (error) {
      if (error instanceof GoogleNeedsConnectingError) {
        console.warn(`[calendar] not watching ${account}; it needs connecting, which only the owner can do in chat`);
        outcomes[account] = "needs_connecting";
      } else {
        console.error(`[calendar] failed to watch ${account}`, error);
        outcomes[account] = "failed";
      }
    }
  }
  return outcomes;
}

// Called while the account's token still works, since only the user who opened a channel can stop
// it. The cursor goes too: a name reconnected to another Google account syncs that calendar afresh.
export async function stopCalendarWatch(
  account: string,
  deps: {
    readonly cache: SharedCache;
    readonly calendarId: string;
    stop(channel: ChannelRecord): Promise<void>;
  },
): Promise<void> {
  const current = await readChannel(deps.cache, account, deps.calendarId);
  if (current) {
    await deps.stop(current).catch((error: unknown) => {
      console.warn(`[calendar] could not stop the channel on ${account}; it lapses within seven days`, error);
    });
  }
  await Promise.all([
    deps.cache.delete(channelKey(account, deps.calendarId)),
    deps.cache.delete(cursorKey(account, deps.calendarId)),
  ]);
}
