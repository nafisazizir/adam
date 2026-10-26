import { stopWatchingCalendar, watchCalendars } from "#lib/calendar-watch.js";
import type { GoogleOwner } from "#lib/google.js";
import { forgetMailbox, stopWatchingMailbox, watchMailboxes } from "#lib/mail-watch.js";
import type { WatchOutcome } from "#lib/new-mail.js";

// Each feed is null when its triggers are off.
export interface GoogleWatches {
  readonly mail: Record<string, WatchOutcome> | null;
  readonly calendar: Record<string, WatchOutcome> | null;
}

// Every push feed Google offers Adam on an account, behind one call, so the tools and the daily
// renewal never name a feed. Without `force` an account known to be watched costs no Google call.
export async function watchGoogleAccounts(
  owner: GoogleOwner,
  options: { readonly accounts?: readonly string[]; readonly force?: boolean } = {},
): Promise<GoogleWatches> {
  const [mail, calendar] = await Promise.all([
    watchMailboxes(owner, options),
    watchCalendars(owner, options.accounts ? { accounts: options.accounts } : {}),
  ]);
  return { mail, calendar };
}

export function isWatching(watches: GoogleWatches, account: string): boolean {
  return [watches.mail?.[account], watches.calendar?.[account]].some(
    (outcome) => outcome === "watching" || outcome === "started",
  );
}

export function anyWatchFailed(watches: GoogleWatches): boolean {
  return [watches.mail, watches.calendar].some((outcomes) => Object.values(outcomes ?? {}).includes("failed"));
}

// Best effort and never throws.
export async function stopWatchingGoogleAccount(owner: GoogleOwner, account: string): Promise<void> {
  await Promise.all([stopWatchingMailbox(owner, account), stopWatchingCalendar(owner, account)]);
}

// Only once an account is really gone.
export async function forgetGoogleAccount(account: string): Promise<void> {
  await forgetMailbox(account);
}
