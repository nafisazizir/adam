import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

import {
  GoogleApiError,
  GoogleNeedsConnectingError,
  type EmailSummary,
  type MailboxHistory,
  type MailboxWatch,
} from "#lib/google.js";
import type { HomeOwner } from "#lib/home-target.js";
import { describeEmailSummary } from "#lib/inbox-view.js";
import { ownerAuth } from "#lib/owner.js";
import { stripWrapperTags } from "#lib/untrusted.js";

export const mailAuthenticator = "mail";

const coalesceWindowMs = 60 * 1000;
const maxHistoryPages = 5;
const maxCandidates = 30;
export const maxEmailsPerTrigger = 10;

export const mailRunSchema = z.object({ emailAddress: z.string().min(1) });

export type MailRun = z.infer<typeof mailRunSchema>;

// Gmail pushes on every inbox change, read marks included. Pushes for a mailbox in the same
// window share one QStash deduplication id, so a burst becomes one run a minute later.
export function coalescedMailRun(emailAddress: string, now: Date = new Date()) {
  const mailbox = emailAddress.trim().toLowerCase();
  return {
    body: { emailAddress: mailbox } satisfies MailRun,
    deduplicationId: `mail-${mailbox.replace(/[^\w-]/gu, "_")}-${Math.floor(now.getTime() / coalesceWindowMs)}`,
    delaySeconds: coalesceWindowMs / 1000,
  };
}

// The model makes the real call; this only drops what is never worth a text, before it costs a turn.
export function mightMatter(email: EmailSummary): boolean {
  if (!email.unread) return false;
  switch (email.category) {
    case "primary":
      return true;
    case "updates":
    case "forums":
      return email.important;
    case "promotions":
    case "social":
      return false;
  }
}

export function noteworthy(emails: readonly EmailSummary[]): EmailSummary[] {
  return emails
    .filter(mightMatter)
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
    .slice(0, maxEmailsPerTrigger);
}

function emailEntry(email: EmailSummary): string {
  const view = describeEmailSummary(email);
  const facts = [view.date ? `received ${view.date}` : null, view.important ? "marked important" : null]
    .filter(Boolean)
    .join(", ");
  return [`- ${facts || "received just now"}`, view.content].join("\n");
}

export function newEmailMessage(account: string, emails: readonly EmailSummary[], timeContext: string): string {
  const body = stripWrapperTags(emails.map(emailEntry).join("\n\n"), "new_email");
  return [
    timeContext,
    "",
    `<new_email account="${stripWrapperTags(account, "new_email").replace(/["<>\n\r]/gu, " ")}">`,
    "New mail reached the user's inbox. Nobody asked for this message; decide whether any of it is worth a text.",
    "",
    body,
    "</new_email>",
    "",
    "Follow your new email rules: if a real person here needs the user, text them in one short message; if nothing does, call the stay_silent tool.",
  ].join("\n");
}

export function mailAuth(owner: HomeOwner, account: string): SessionAuthContext {
  return ownerAuth(owner, { authenticator: mailAuthenticator, attributes: { account } });
}

export interface MailboxState {
  readonly historyId: string;
  // Noteworthy messages claimed by a run but not yet delivered; a retry or the next run sends them.
  readonly pending?: readonly string[];
}

export const mailboxStateSchema = z.object({
  historyId: z.string().min(1),
  pending: z.array(z.string()).optional(),
});

export class MailboxStateConflict extends Error {}

export interface MailboxStateStore {
  read(account: string): Promise<{ state: MailboxState; etag: string } | null>;
  // Throws MailboxStateConflict when the document changed since `expected`.
  write(account: string, state: MailboxState, expected: { etag: string } | "absent"): Promise<{ etag: string }>;
}

export interface MailboxReader {
  history(startHistoryId: string, pageToken?: string): Promise<MailboxHistory>;
  summaries(ids: readonly string[]): Promise<EmailSummary[]>;
  currentHistoryId(): Promise<string>;
}

export type MailRunOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "reset" }
  | { readonly kind: "busy" }
  | { readonly kind: "quiet"; readonly checked: number }
  | { readonly kind: "delivered"; readonly count: number };

function isTooOld(error: unknown): boolean {
  return error instanceof GoogleApiError && error.status === 404;
}

async function addedSince(mailbox: MailboxReader, startHistoryId: string) {
  const ids: string[] = [];
  let historyId = startHistoryId;
  let pageToken: string | undefined;
  for (let page = 0; page < maxHistoryPages; page += 1) {
    const history = await mailbox.history(startHistoryId, pageToken);
    ids.push(...history.addedMessageIds);
    historyId = history.historyId;
    pageToken = history.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return { ids, historyId };
}

async function writeState(
  store: MailboxStateStore,
  account: string,
  state: MailboxState,
  expected: { etag: string } | "absent",
): Promise<{ etag: string } | null> {
  try {
    return await store.write(account, state, expected);
  } catch (error) {
    if (error instanceof MailboxStateConflict) return null;
    throw error;
  }
}

// The history id and the claimed messages advance in one conditional write before delivery, so a
// concurrent run backs off and a failed delivery stays pending instead of being lost or doubled.
export async function processMailbox(
  account: string,
  deps: {
    readonly store: MailboxStateStore;
    readonly mailbox: MailboxReader;
    deliver(emails: readonly EmailSummary[]): Promise<void>;
  },
): Promise<MailRunOutcome> {
  const { store, mailbox } = deps;
  const current = await store.read(account);
  if (!current) {
    const started = await writeState(store, account, { historyId: await mailbox.currentHistoryId() }, "absent");
    return started ? { kind: "started" } : { kind: "busy" };
  }

  const pending = current.state.pending ?? [];
  let added: Awaited<ReturnType<typeof addedSince>>;
  try {
    added = await addedSince(mailbox, current.state.historyId);
  } catch (error) {
    if (!isTooOld(error)) throw error;
    const reset = { historyId: await mailbox.currentHistoryId(), ...(pending.length ? { pending } : {}) };
    return (await writeState(store, account, reset, { etag: current.etag })) ? { kind: "reset" } : { kind: "busy" };
  }

  const candidates = [...new Set([...pending, ...added.ids.slice(-maxCandidates)])];
  const emails = noteworthy(candidates.length ? await mailbox.summaries(candidates) : []);
  const claimed: MailboxState = {
    historyId: added.historyId,
    ...(emails.length ? { pending: emails.map((email) => email.id) } : {}),
  };
  if (added.historyId === current.state.historyId && !pending.length && !emails.length) {
    return { kind: "quiet", checked: 0 };
  }

  const written = await writeState(store, account, claimed, { etag: current.etag });
  if (!written) return { kind: "busy" };
  if (!emails.length) return { kind: "quiet", checked: candidates.length };

  await deps.deliver(emails);
  const cleared = await writeState(store, account, { historyId: added.historyId }, written).catch((error: unknown) => {
    console.warn(`[mail] delivered ${account} but could not clear its pending messages`, error);
    return null;
  });
  if (!cleared) console.warn(`[mail] ${account} still lists delivered messages as pending; the next run resends them`);
  return { kind: "delivered", count: emails.length };
}

export type WatchOutcome = "watching" | "started" | "needs_connecting" | "failed";

// Gmail stops pushing after seven days, so this runs daily. The first watch also records where the
// mailbox's history starts, so the first push has something to read from.
export async function renewMailboxWatches(
  accounts: readonly string[],
  deps: { readonly store: MailboxStateStore; watch(account: string): Promise<MailboxWatch> },
): Promise<Record<string, WatchOutcome>> {
  const outcomes: Record<string, WatchOutcome> = {};
  for (const account of accounts) {
    try {
      const watch = await deps.watch(account);
      const started = (await deps.store.read(account)) === null;
      if (started) await writeState(deps.store, account, { historyId: watch.historyId }, "absent");
      outcomes[account] = started ? "started" : "watching";
    } catch (error) {
      if (error instanceof GoogleNeedsConnectingError) {
        console.warn(`[mail] not watching ${account}; it needs connecting, which only the owner can do in chat`);
        outcomes[account] = "needs_connecting";
      } else {
        console.error(`[mail] failed to watch ${account}`, error);
        outcomes[account] = "failed";
      }
    }
  }
  return outcomes;
}
