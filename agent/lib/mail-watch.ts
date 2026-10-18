import { env } from "#lib/env.js";
import { google, type GoogleOwner } from "#lib/google.js";
import { blobMailboxStateStore } from "#lib/mailbox-state-store.js";
import { renewMailboxWatches, type WatchOutcome } from "#lib/new-mail.js";

// Null when new-mail triggers are off (no topic or no Google accounts).
export async function watchMailboxes(
  owner: GoogleOwner,
  accounts?: readonly string[],
): Promise<Record<string, WatchOutcome> | null> {
  const topic = env.GOOGLE_PUBSUB_TOPIC;
  if (!topic || !google.configured) return null;
  return renewMailboxWatches(accounts ?? (await google.accountNames(owner)), {
    store: blobMailboxStateStore,
    watch: (account) => google.watchMailbox(owner, account, topic),
  });
}
