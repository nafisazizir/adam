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
import type { SharedCache } from "#lib/shared-cache.js";

export const mailAuthenticator = "mail";

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;
const coalesceWindowMs = 3 * minuteMs;
const runAfterWindowSeconds = 5;
export const dailyMailRunCap = 120;
const maxHistoryPages = 5;
const maxCandidates = 30;
export const maxEmailsPerTrigger = 10;
const maxDeliveredIds = 200;
const maxClaimAttempts = 3;
export const claimLeaseMs = 2 * minuteMs;
const takeoverWindowMs = 6 * hourMs;
export const checkpointEveryMs = 6 * hourMs;
const cursorTtlSeconds = 8 * 24 * 60 * 60;
const deliveredMarkerTtlSeconds = 7 * 60 * 60;
const runCountTtlSeconds = 2 * 24 * 60 * 60;

export const mailRunSchema = z.object({ emailAddress: z.string().min(1) });

export type MailRun = z.infer<typeof mailRunSchema>;

// Gmail pushes on every inbox change, read marks included. Every push in one window shares a QStash
// deduplication id and a run just after the window closes, so a burst becomes one run, and runs for
// the same mailbox are a window apart.
export function coalescedMailRun(emailAddress: string, now: Date = new Date()) {
  const mailbox = emailAddress.trim().toLowerCase();
  const window = Math.floor(now.getTime() / coalesceWindowMs);
  const windowEnd = (window + 1) * coalesceWindowMs;
  return {
    body: { emailAddress: mailbox } satisfies MailRun,
    deduplicationId: `mail-${mailbox.replace(/[^\w-]/gu, "_")}-${window}`,
    delaySeconds: Math.ceil((windowEnd - now.getTime()) / 1000) + runAfterWindowSeconds,
  };
}

// Mail must never spend the QStash budget reminders and coding watches rely on. Best effort: the
// count is not atomic, which can only let a few extra runs through.
export async function takeDailyMailRun(cache: SharedCache, mailbox: string, day: string): Promise<boolean> {
  const key = `mail-runs:${mailbox.trim().toLowerCase()}:${day}`;
  const used = Number(await cache.get(key)) || 0;
  if (used >= dailyMailRunCap) {
    if (used === dailyMailRunCap) {
      console.warn(`[mail] a mailbox reached ${dailyMailRunCap} runs on ${day}; its new mail waits until tomorrow`);
      await cache.set(key, used + 1, runCountTtlSeconds);
    }
    return false;
  }
  await cache.set(key, used + 1, runCountTtlSeconds);
  return true;
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
  const unique = [...new Map(emails.map((email) => [email.id, email])).values()];
  return unique
    .filter(mightMatter)
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
    .slice(0, maxEmailsPerTrigger);
}

function emailEntry(email: EmailSummary): string {
  const view = describeEmailSummary(email, ["new_email"]);
  const facts = [view.date ? `received ${view.date}` : null, view.important ? "marked important" : null]
    .filter(Boolean)
    .join(", ");
  return [`- ${facts || "received just now"}`, view.content].join("\n");
}

// The account is a GOOGLE_CONNECTORS label, which env.ts limits to [a-z0-9_-].
export function newEmailMessage(account: string, emails: readonly EmailSummary[], timeContext: string): string {
  return [
    timeContext,
    "",
    `<new_email account="${account}">`,
    "New mail reached the user's inbox. Nobody asked for this message; decide whether any of it is worth a text.",
    "",
    emails.map(emailEntry).join("\n\n"),
    "</new_email>",
    "",
    "Follow your new email rules: if a real person here needs the user, text them in one short message; if nothing does, call the stay_silent tool.",
  ].join("\n");
}

export function mailAuth(owner: HomeOwner, account: string): SessionAuthContext {
  return ownerAuth(owner, { authenticator: mailAuthenticator, attributes: { account } });
}

const claimSchema = z.object({
  ids: z.array(z.string()),
  claimId: z.string(),
  claimedAt: z.number(),
});

export const mailboxStateSchema = z.object({
  historyId: z.string().min(1),
  checkpointedAt: z.number().default(0),
  delivered: z.array(z.string()).default([]),
  claim: claimSchema.optional(),
});

// The durable record, written only to claim mail for delivery and as a checkpoint every few hours.
// `delivered` keeps the newest ids ever claimed, so replaying history from an older checkpoint never
// texts twice; `claim` is a lease on one delivery, owned by one QStash message.
export type MailboxState = z.infer<typeof mailboxStateSchema>;

export class MailboxStateConflict extends Error {}

export interface StoredMailboxState {
  readonly state: MailboxState;
  readonly etag: string;
}

export interface MailboxStateStore {
  read(account: string): Promise<StoredMailboxState | null>;
  // Throws MailboxStateConflict when the document changed since `expected`.
  write(account: string, state: MailboxState, expected: { etag: string } | "absent"): Promise<{ etag: string }>;
}

export interface MailboxReader {
  history(startHistoryId: string, pageToken?: string): Promise<MailboxHistory>;
  summaries(ids: readonly string[]): Promise<EmailSummary[]>;
  // The newest unread inbox mail, for when history has more pages than a run reads.
  recentUnread(): Promise<EmailSummary[]>;
  currentHistoryId(): Promise<string>;
}

// The fast cursor every run reads, kept in the shared cache, with Blob as its fallback.
const cursorSchema = z.object({ historyId: z.string(), checkpointedAt: z.number(), openClaim: z.boolean() });

type Cursor = z.infer<typeof cursorSchema>;

export type MailRunOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "reset" }
  | { readonly kind: "leased" }
  | { readonly kind: "quiet"; readonly checked: number }
  | { readonly kind: "delivered"; readonly count: number };

export interface MailRunDeps {
  readonly store: MailboxStateStore;
  readonly cache: SharedCache;
  readonly mailbox: MailboxReader;
  // Stable across retries of one run (the QStash message id), so a retry resumes its own claim.
  readonly claimId: string;
  readonly now?: () => number;
  deliver(emails: readonly EmailSummary[]): Promise<void>;
}

function isTooOld(error: unknown): boolean {
  return error instanceof GoogleApiError && error.status === 404;
}

function laterHistoryId(a: string, b: string): string {
  try {
    return BigInt(a) >= BigInt(b) ? a : b;
  } catch {
    return b;
  }
}

const cursorKey = (account: string) => `mail-cursor:${account}`;
const deliveredKey = (claimId: string) => `mail-delivered:${claimId}`;

async function readCursor(cache: SharedCache, account: string): Promise<Cursor | null> {
  const parsed = cursorSchema.safeParse(await cache.get(cursorKey(account)));
  return parsed.success ? parsed.data : null;
}

async function writeCursor(cache: SharedCache, account: string, cursor: Cursor): Promise<void> {
  const current = await readCursor(cache, account);
  const historyId = current ? laterHistoryId(current.historyId, cursor.historyId) : cursor.historyId;
  await cache.set(cursorKey(account), { ...cursor, historyId }, cursorTtlSeconds);
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
    if (!pageToken) return { ids, historyId, truncated: false };
  }
  return { ids, historyId, truncated: true };
}

// Read-modify-write with a bounded retry: a conflict means another run wrote first, so decide again
// against what it wrote.
async function updateState<T>(
  store: MailboxStateStore,
  account: string,
  first: StoredMailboxState | null | undefined,
  decide: (current: StoredMailboxState | null) => Promise<{ next: MailboxState | null; result: T }>,
): Promise<T> {
  let current = first === undefined ? await store.read(account) : first;
  for (let attempt = 1; ; attempt += 1) {
    const { next, result } = await decide(current);
    if (!next) return result;
    try {
      await store.write(account, next, current ? { etag: current.etag } : "absent");
      return result;
    } catch (error) {
      if (!(error instanceof MailboxStateConflict) || attempt >= maxClaimAttempts) throw error;
      current = await store.read(account);
    }
  }
}

type Decision =
  | { readonly kind: "leased" }
  | { readonly kind: "quiet"; readonly checked: number }
  | { readonly kind: "claimed"; readonly emails: EmailSummary[] };

// Exactly-once rests on the claim: mail is marked delivered and leased to this run in one
// conditional write before it is sent. Another run skips a live lease and takes over only an
// expired one that never reported done, so overlapping runs and QStash retries text once. After
// the cache is lost an expired claim is left alone: missing one heads-up beats sending it twice.
export async function processMailbox(account: string, deps: MailRunDeps): Promise<MailRunOutcome> {
  const { store, cache, mailbox, claimId } = deps;
  const now = (deps.now ?? Date.now)();

  let stored: StoredMailboxState | null | undefined;
  let cursor = await readCursor(cache, account);
  // Done markers live in the same cache, so without the cursor they are likely gone too.
  const cacheWasCold = cursor === null;
  if (!cursor) {
    stored = await store.read(account);
    if (!stored) {
      const historyId = await mailbox.currentHistoryId();
      await updateState(store, account, null, async (current) => ({
        next: current ? null : { historyId, checkpointedAt: now, delivered: [] },
        result: undefined,
      }));
      await writeCursor(cache, account, { historyId, checkpointedAt: now, openClaim: false });
      return { kind: "started" };
    }
    cursor = {
      historyId: stored.state.historyId,
      checkpointedAt: stored.state.checkpointedAt,
      openClaim: stored.state.claim !== undefined,
    };
  }

  let added: Awaited<ReturnType<typeof addedSince>>;
  try {
    added = await addedSince(mailbox, cursor.historyId);
  } catch (error) {
    if (!isTooOld(error)) throw error;
    const historyId = await mailbox.currentHistoryId();
    await updateState(store, account, stored, async (current) => ({
      next: { ...(current?.state ?? { delivered: [] }), historyId, checkpointedAt: now },
      result: undefined,
    }));
    await writeCursor(cache, account, { historyId, checkpointedAt: now, openClaim: cursor.openClaim });
    return { kind: "reset" };
  }

  let candidates: EmailSummary[];
  if (added.truncated) {
    console.warn(`[mail] ${account} has more history than a run reads; checking its newest unread mail instead`);
    candidates = await mailbox.recentUnread();
  } else {
    const ids = [...new Set(added.ids)].slice(-maxCandidates);
    candidates = ids.length ? await mailbox.summaries(ids) : [];
  }
  const found = noteworthy(candidates);

  if (!found.length && !cursor.openClaim && now - cursor.checkpointedAt < checkpointEveryMs) {
    await writeCursor(cache, account, { ...cursor, historyId: added.historyId });
    return { kind: "quiet", checked: candidates.length };
  }

  const decision = await updateState<Decision>(store, account, stored, async (current) => {
    const state = current?.state;
    const historyId = state ? laterHistoryId(state.historyId, added.historyId) : added.historyId;
    const delivered = new Set(state?.delivered ?? []);

    let carried: string[] = [];
    const claim = state?.claim;
    if (claim && !(await cache.get(deliveredKey(claim.claimId)))) {
      const age = now - claim.claimedAt;
      if (claim.claimId === claimId) carried = claim.ids;
      else if (age < claimLeaseMs) return { next: null, result: { kind: "leased" } };
      else if (age < takeoverWindowMs && !cacheWasCold) carried = claim.ids;
    }

    const fresh = found.filter((email) => !delivered.has(email.id));
    const missing = carried.filter((id) => !fresh.some((email) => email.id === id));
    const emails = noteworthy([...fresh, ...(missing.length ? await mailbox.summaries(missing) : [])]);

    if (!emails.length) {
      const due = !state || now - state.checkpointedAt >= checkpointEveryMs || carried.length > 0;
      return {
        next: due ? { historyId, checkpointedAt: now, delivered: [...delivered] } : null,
        result: { kind: "quiet", checked: candidates.length },
      };
    }

    const ids = emails.map((email) => email.id);
    return {
      next: {
        historyId,
        checkpointedAt: now,
        delivered: [...new Set([...delivered, ...ids])].slice(-maxDeliveredIds),
        claim: { ids, claimId, claimedAt: now },
      },
      result: { kind: "claimed", emails },
    };
  });

  if (decision.kind === "leased") return decision;
  if (decision.kind === "quiet") {
    await writeCursor(cache, account, { historyId: added.historyId, checkpointedAt: now, openClaim: false });
    return decision;
  }

  await writeCursor(cache, account, { historyId: added.historyId, checkpointedAt: now, openClaim: true });
  await deps.deliver(decision.emails);
  await cache.set(deliveredKey(claimId), true, deliveredMarkerTtlSeconds);
  await writeCursor(cache, account, { historyId: added.historyId, checkpointedAt: now, openClaim: false });
  return { kind: "delivered", count: decision.emails.length };
}

export type WatchOutcome = "watching" | "started" | "needs_connecting" | "failed";

// Gmail stops pushing after seven days, so this runs daily. The first watch also records where the
// mailbox's history starts, so the first push has something to read from.
export async function renewMailboxWatches(
  accounts: readonly string[],
  deps: {
    readonly store: MailboxStateStore;
    readonly now?: () => number;
    watch(account: string): Promise<MailboxWatch>;
  },
): Promise<Record<string, WatchOutcome>> {
  const outcomes: Record<string, WatchOutcome> = {};
  for (const account of accounts) {
    try {
      const watch = await deps.watch(account);
      outcomes[account] = await updateState<WatchOutcome>(deps.store, account, undefined, async (current) =>
        current
          ? { next: null, result: "watching" }
          : {
              next: { historyId: watch.historyId, checkpointedAt: (deps.now ?? Date.now)(), delivered: [] },
              result: "started",
            },
      );
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
