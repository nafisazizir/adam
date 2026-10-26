import type { BriefingContext, BriefingSection } from "#lib/briefing.js";
import { google, type CalendarEvent, type EmailSummary, type GoogleWorkspace } from "#lib/google.js";
import { describeEmailSummary, describeEvent, describeSpan } from "#lib/inbox-view.js";
import { blobMailboxStateStore } from "#lib/mailbox-state-store.js";
import { deliveredMail, mightMatter, noteworthy, type MailboxStateStore } from "#lib/new-mail.js";
import { userTimeZone } from "#lib/time.js";
import { startOfNextLocalDay } from "#lib/zoned-time.js";

const minuteMs = 60 * 1000;
export const mailLookbackMs = 24 * 60 * minuteMs;
// A new-mail run waits out a three-minute window before it reads the mailbox, so the newest mail in
// a watched mailbox is left to it. The next briefing's window reaches back over this gap, so mail
// the run never handed over still turns up there.
export const pushSettleMs = 10 * minuteMs;
const maxEvents = 25;
const maxMailCandidates = 50;
const wrappers = ["briefing"];

// Only the tabs `mightMatter` always drops are left to Gmail: `category:primary` would miss mail with
// no category label, which `mightMatter` counts as Primary.
export function unreadMailQuery(since: Date): string {
  const after = Math.floor(since.getTime() / 1000);
  return `in:inbox is:unread -category:promotions -category:social after:${after}`;
}

// `delivered` holds, per account, what new-mail triggers already handed over, or null when nothing
// watches that mailbox and the briefing is the only way its mail reaches the user.
export function briefingMail(
  candidates: readonly EmailSummary[],
  delivered: ReadonlyMap<string, ReadonlySet<string> | null>,
  now: Date,
): { emails: EmailSummary[]; more: boolean } {
  const end = now.getTime();
  const eligible = candidates.filter((email) => {
    const at = email.date?.getTime();
    if (at === undefined) return false;
    const pushed = delivered.get(email.account);
    if (!pushed) return at > end - mailLookbackMs && at <= end;
    return !pushed.has(email.id) && at > end - mailLookbackMs - pushSettleMs && at <= end - pushSettleMs;
  });
  const emails = noteworthy(eligible);
  return { emails, more: eligible.filter(mightMatter).length > emails.length };
}

export interface GoogleBriefing {
  readonly events: readonly CalendarEvent[];
  readonly moreEvents: boolean;
  readonly mail: readonly EmailSummary[];
  readonly moreMail: boolean;
  readonly needsConnecting: readonly string[];
}

function responseNote(event: CalendarEvent): string | null {
  if (event.myResponse === "needsAction") return "not answered yet";
  if (event.myResponse === "tentative") return "answered maybe";
  return null;
}

function eventEntry(event: CalendarEvent): string {
  const facts = [describeSpan(event.start, event.end), responseNote(event)].filter(Boolean).join(", ");
  return [`- ${facts}`, describeEvent(event, wrappers).content].join("\n");
}

function emailEntry(email: EmailSummary): string {
  const view = describeEmailSummary(email, wrappers);
  const facts = [view.date ? `received ${view.date}` : null, view.important ? "marked important" : null]
    .filter(Boolean)
    .join(", ");
  return [`- ${facts || "received in the last day"}`, view.content].join("\n");
}

function block(heading: string, entries: readonly string[], more: string | null): string {
  return [heading, ...entries, more].filter(Boolean).join("\n");
}

export function renderGoogleBriefing(briefing: GoogleBriefing): string | null {
  const events = briefing.events.filter((event) => event.myResponse !== "declined");
  const parts: string[] = [];
  if (events.length) {
    parts.push(
      block(
        "The rest of today's calendar, across their Google accounts:",
        events.map(eventEntry),
        briefing.moreEvents ? "(There are more events today than listed here.)" : null,
      ),
    );
  }
  if (briefing.mail.length) {
    parts.push(
      block(
        "Unread inbox mail from the last day that might need them. Mail a <new_email> message already brought you is left out:",
        briefing.mail.map(emailEntry),
        briefing.moreMail ? "(More unread mail like this came in than is listed here.)" : null,
      ),
    );
  }
  if (briefing.needsConnecting.length) {
    parts.push(
      `These Google accounts need connecting, so they were not read: ${briefing.needsConnecting.join(", ")}. ` +
        "Tell them in a line, and that they can text you directly for a fresh link.",
    );
  }
  return parts.length ? parts.join("\n\n") : null;
}

export interface GoogleBriefingDeps {
  readonly workspace: Pick<GoogleWorkspace, "configured" | "accountNames" | "listEvents" | "searchEmail">;
  readonly mailboxes: Pick<MailboxStateStore, "read">;
  readonly timeZone: string;
}

export function googleBriefingSection(deps: GoogleBriefingDeps): BriefingSection {
  const { workspace, mailboxes, timeZone } = deps;

  // Only accounts that have candidate mail cost a Blob read. One whose state cannot be read is
  // left out: a missed line in the briefing beats repeating a heads-up.
  async function deliveredByAccount(emails: readonly EmailSummary[]) {
    const delivered = new Map<string, ReadonlySet<string> | null>();
    await Promise.all(
      [...new Set(emails.map((email) => email.account))].map(async (account) => {
        try {
          delivered.set(account, await deliveredMail(mailboxes, account));
        } catch (error) {
          console.warn(`[briefing] leaving out ${account} mail; its new-mail state could not be read`, error);
        }
      }),
    );
    return delivered;
  }

  return {
    name: "google",
    async render({ owner, now }: BriefingContext) {
      if (!workspace.configured || !(await workspace.accountNames(owner)).length) return null;

      const since = new Date(now.getTime() - mailLookbackMs - pushSettleMs);
      const [events, mail] = await Promise.all([
        workspace.listEvents(
          owner,
          { from: now, to: startOfNextLocalDay(now, timeZone) },
          { primaryOnly: false, max: maxEvents },
        ),
        workspace.searchEmail(owner, unreadMailQuery(since), { max: maxMailCandidates }),
      ]);
      const delivered = await deliveredByAccount(mail.results);
      const shown = briefingMail(
        mail.results.filter((email) => delivered.has(email.account)),
        delivered,
        now,
      );

      if (mail.truncated) console.warn(`[briefing] only the ${maxMailCandidates} newest unread emails were checked`);
      const errors = [...events.errors, ...mail.errors];
      for (const error of errors) {
        if (!error.needsConnecting) console.warn(`[briefing] google ${error.account}: ${error.error}`);
      }
      return renderGoogleBriefing({
        events: events.results,
        moreEvents: events.truncated,
        mail: shown.emails,
        moreMail: shown.more,
        needsConnecting: [...new Set(errors.filter((error) => error.needsConnecting).map((error) => error.account))],
      });
    },
  };
}

export const googleBriefing = googleBriefingSection({
  workspace: google,
  mailboxes: blobMailboxStateStore,
  timeZone: userTimeZone,
});
