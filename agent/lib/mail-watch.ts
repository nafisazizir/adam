import { env } from "#lib/env.js";
import { google, type GoogleOwner } from "#lib/google.js";
import { blobMailboxStateStore } from "#lib/mailbox-state-store.js";
import { forgetMailbox, renewMailboxWatches, type WatchOutcome } from "#lib/new-mail.js";
import { secretCache } from "#lib/shared-cache.js";

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

// Best effort, before the account is disconnected: a failure here never blocks the disconnect.
export async function stopWatchingMailbox(owner: GoogleOwner, account: string): Promise<void> {
  if (!env.GOOGLE_PUBSUB_TOPIC || !google.configured) return;
  try {
    await forgetMailbox(account, {
      store: blobMailboxStateStore,
      cache: secretCache,
      stop: () => google.stopMailboxWatch(owner, account),
    });
  } catch (error) {
    console.warn(`[mail] could not forget the mailbox state of ${account}`, error);
  }
}
