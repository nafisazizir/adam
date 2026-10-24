import { defineChannel, POST } from "eve/channels";

import { homeDelivery } from "#lib/delivery.js";
import { env, mailProcessPath, mailPushPath } from "#lib/env.js";
import { google, type GoogleOwner } from "#lib/google.js";
import { mailPushHandler, mailRunHandler } from "#lib/mail-routes.js";
import { blobMailboxStateStore } from "#lib/mailbox-state-store.js";
import type { MailboxReader } from "#lib/new-mail.js";
import { googleSigningKeys } from "#lib/pubsub-push.js";
import { hasValidCallbackSignature, publishCallback } from "#lib/qstash.js";
import { secretCache } from "#lib/shared-cache.js";
import { currentTimeContext, userLocalDate } from "#lib/time.js";

function gmailReader(owner: GoogleOwner, account: string): MailboxReader {
  return {
    history: (startHistoryId, pageToken) => google.mailboxHistory(owner, account, startHistoryId, pageToken),
    summaries: (ids) => google.emailSummaries(owner, account, ids),
    currentHistoryId: async () => (await google.mailboxProfile(owner, account)).historyId,
    async recentUnread() {
      const found = await google.searchEmail(owner, "in:inbox is:unread newer_than:1d", { account, max: 30 });
      if (found.errors[0]) throw new Error(found.errors[0].error);
      return found.results;
    },
  };
}

const push = mailPushHandler({
  audience: env.mailPushUrl,
  serviceAccount: env.GOOGLE_PUSH_SERVICE_ACCOUNT,
  keys: googleSigningKeys,
  cache: secretCache,
  today: () => userLocalDate(),
  publish: async (run) => {
    await publishCallback({ url: env.mailProcessUrl, ...run });
  },
});

const processRun = mailRunHandler({
  store: blobMailboxStateStore,
  cache: secretCache,
  timeContext: () => currentTimeContext(),
  verify: (request, body) => hasValidCallbackSignature(request, body, env.mailProcessUrl),
  accountWithAddress: (owner, address) => google.accountWithAddress(owner, address),
  isListed: async (owner, account) => (await google.accountNames(owner)).includes(account),
  reader: gmailReader,
});

export default defineChannel({
  routes: [
    POST(mailPushPath, (request) => push(request)),
    POST(mailProcessPath, (request, { to }) =>
      processRun(request, async () => {
        const home = await homeDelivery();
        if (!home) return null;
        const { channel, target, owner } = home;
        return {
          owner,
          async deliver(message, auth) {
            await channel.deliver({ to, message, target, auth, turnPolicy: "queue" });
          },
        };
      }),
    ),
  ],
});
