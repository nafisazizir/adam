import { env } from "#lib/env.js";
import { google, type GoogleOwner } from "#lib/google.js";
import { blobMailboxStateStore } from "#lib/mailbox-state-store.js";
import { forgetMailboxState, renewMailboxWatches, stopWatch, type WatchOutcome } from "#lib/new-mail.js";
import { secretCache } from "#lib/shared-cache.js";

function enabled(): string | null {
  return env.GOOGLE_PUBSUB_TOPIC && google.configured ? env.GOOGLE_PUBSUB_TOPIC : null;
}

// Null when new-mail triggers are off (no topic or no Google connector). Without `force`, an account
// whose watch is known to be live is skipped.
export async function watchMailboxes(
  owner: GoogleOwner,
  options: { readonly accounts?: readonly string[]; readonly force?: boolean } = {},
): Promise<Record<string, WatchOutcome> | null> {
  const topic = enabled();
  if (!topic) return null;
  return renewMailboxWatches(options.accounts ?? (await google.accountNames(owner)), {
    store: blobMailboxStateStore,
    cache: secretCache,
    force: options.force ?? false,
    async watch(account) {
      const watch = await google.watchMailbox(owner, account, topic);
      const { emailAddress } = await google.mailboxProfile(owner, account);
      return { ...watch, emailAddress };
    },
  });
}

// Best effort and never throws: it runs before a disconnect or a reconnect, while the old token
// still works.
export async function stopWatchingMailbox(owner: GoogleOwner, account: string): Promise<void> {
  if (!enabled()) return;
  await stopWatch(account, { cache: secretCache, stop: () => google.stopMailboxWatch(owner, account) }).catch(
    (error: unknown) => console.warn(`[mail] could not stop watching ${account}`, error),
  );
}

export async function forgetMailbox(account: string): Promise<void> {
  if (!enabled()) return;
  await forgetMailboxState(account, { store: blobMailboxStateStore, cache: secretCache }).catch((error: unknown) =>
    console.warn(`[mail] could not forget the mailbox state of ${account}`, error),
  );
}
