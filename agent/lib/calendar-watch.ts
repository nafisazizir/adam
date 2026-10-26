import { noteOwnEdit, renewCalendarWatches, stopCalendarWatch, type CalendarReader } from "#lib/calendar-changes.js";
import { calendarChannelTokens } from "#lib/calendar-push.js";
import { env } from "#lib/env.js";
import { google, type GoogleOwner } from "#lib/google.js";
import type { WatchOutcome } from "#lib/new-mail.js";
import { secretCache } from "#lib/shared-cache.js";

// The primary calendar is where invitations land and what Adam writes to; shared and subscribed
// calendars change under other people all day.
export const watchedCalendarId = "primary";

// Same root secret as secretCache, so rotating it resets both: channels then fail their token check
// until the next renewal opens new ones.
export const calendarTokens = calendarChannelTokens(env.QSTASH_CURRENT_SIGNING_KEY);

// Google only pushes to https with a trusted certificate.
function enabled(): boolean {
  return google.configured && env.calendarPushUrl.startsWith("https://");
}

export function calendarReader(owner: GoogleOwner, account: string, calendarId: string): CalendarReader {
  return { changes: (cursor) => google.calendarChanges(owner, account, calendarId, cursor) };
}

// Null when calendar triggers are off (no Google connector, or no https BASE_URL).
export async function watchCalendars(
  owner: GoogleOwner,
  options: { readonly accounts?: readonly string[] } = {},
): Promise<Record<string, WatchOutcome> | null> {
  if (!enabled()) return null;
  return renewCalendarWatches(options.accounts ?? (await google.accountNames(owner)), {
    cache: secretCache,
    calendarId: watchedCalendarId,
    address: env.calendarPushUrl,
    tokens: calendarTokens,
    reader: (account) => calendarReader(owner, account, watchedCalendarId),
    watch: (account, request) => google.watchCalendar(owner, account, request),
    stop: (account, channel) => google.stopCalendarWatch(owner, account, channel),
  });
}

// So a change Adam made for the owner is never told back to them as someone else's.
export async function noteOwnCalendarEdit(account: string, eventId: string): Promise<void> {
  if (enabled()) await noteOwnEdit(secretCache, account, eventId);
}

// Best effort and never throws: it runs before a disconnect or a reconnect, while the old token
// still works.
export async function stopWatchingCalendar(owner: GoogleOwner, account: string): Promise<void> {
  if (!enabled()) return;
  await stopCalendarWatch(account, {
    cache: secretCache,
    calendarId: watchedCalendarId,
    stop: (channel) => google.stopCalendarWatch(owner, account, channel),
  }).catch((error: unknown) => console.warn(`[calendar] could not stop watching ${account}`, error));
}
