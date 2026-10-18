import { defineChannel, POST } from "eve/channels";

import { homeDelivery } from "#lib/delivery.js";
import { env, mailProcessPath, mailPushPath } from "#lib/env.js";
import { google, GoogleNeedsConnectingError, type GoogleOwner } from "#lib/google.js";
import { blobMailboxStateStore } from "#lib/mailbox-state-store.js";
import {
  coalescedMailRun,
  mailAuth,
  mailRunSchema,
  newEmailMessage,
  processMailbox,
  type MailboxReader,
} from "#lib/new-mail.js";
import { googleSigningKeys, isAuthenticPush, parseMailboxNotification } from "#lib/pubsub-push.js";
import { hasValidCallbackSignature, parseJson, publishCallback } from "#lib/qstash.js";
import { sharedCache } from "#lib/shared-cache.js";
import { currentTimeContext } from "#lib/time.js";

const queuedTtlSeconds = 120;

function gmailReader(owner: GoogleOwner, account: string): MailboxReader {
  return {
    history: (startHistoryId, pageToken) => google.mailboxHistory(owner, account, startHistoryId, pageToken),
    summaries: (ids) => google.emailSummaries(owner, account, ids),
    currentHistoryId: () => google.currentHistoryId(owner, account),
  };
}

export default defineChannel({
  routes: [
    POST(mailPushPath, async (request) => {
      if (!env.GOOGLE_PUSH_SERVICE_ACCOUNT) {
        console.warn("[mail] rejected a push; GOOGLE_PUSH_SERVICE_ACCOUNT is not set");
        return Response.json({ ok: false, error: "not_configured" }, { status: 401 });
      }
      const authentic = await isAuthenticPush(request.headers.get("authorization"), {
        audience: env.mailPushUrl,
        serviceAccount: env.GOOGLE_PUSH_SERVICE_ACCOUNT,
        keys: googleSigningKeys(),
      });
      if (!authentic) {
        console.warn("[mail] rejected a push without a valid Pub/Sub token");
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }

      // Acknowledged anyway: Pub/Sub would redeliver a malformed message until it expires.
      const notification = parseMailboxNotification(await request.json().catch(() => null));
      if (!notification) {
        console.warn("[mail] ignoring a malformed push");
        return Response.json({ ok: true, ignored: "invalid_payload" });
      }

      const run = coalescedMailRun(notification.emailAddress);
      const queuedKey = `mail-queued:${run.deduplicationId}`;
      if (await sharedCache.get(queuedKey)) return Response.json({ ok: true, coalesced: true });

      try {
        await publishCallback({ url: env.mailProcessUrl, ...run });
      } catch (error) {
        console.error("[mail] failed to queue a mailbox run", error);
        return Response.json({ ok: false, error: "publish_failed" }, { status: 500 });
      }
      await sharedCache.set(queuedKey, true, queuedTtlSeconds);
      return Response.json({ ok: true });
    }),
    POST(mailProcessPath, async (request, { to }) => {
      const body = await request.text();
      if (!(await hasValidCallbackSignature(request, body, env.mailProcessUrl))) {
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }

      const parsed = mailRunSchema.safeParse(parseJson(body));
      if (!parsed.success) {
        console.warn("[mail] rejected malformed mailbox run");
        return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
      }

      const home = await homeDelivery();
      if (!home) {
        console.warn("[mail] skipping new mail; no home delivery target is stored");
        return Response.json({ ok: true, ignored: "no_home_target" });
      }
      const { channel, target, owner } = home;

      let account: string | null;
      try {
        account = await google.accountWithAddress(owner, parsed.data.emailAddress);
      } catch (error) {
        console.warn("[mail] skipping new mail; Google is not usable", error);
        return Response.json({ ok: true, ignored: "google_unavailable" });
      }
      if (!account) {
        console.warn("[mail] skipping new mail; no connected account has the pushed address");
        return Response.json({ ok: true, ignored: "unknown_mailbox" });
      }

      try {
        const mailboxAccount = account;
        const outcome = await processMailbox(mailboxAccount, {
          store: blobMailboxStateStore,
          mailbox: gmailReader(owner, mailboxAccount),
          deliver: async (emails) => {
            await channel.deliver({
              to,
              message: newEmailMessage(mailboxAccount, emails, currentTimeContext()),
              target,
              auth: mailAuth(owner, mailboxAccount),
              turnPolicy: "queue",
            });
          },
        });
        console.log(`[mail] ${mailboxAccount}: ${JSON.stringify(outcome)}`);
        return Response.json({ ok: true, ...outcome });
      } catch (error) {
        if (error instanceof GoogleNeedsConnectingError) {
          console.warn(`[mail] skipping new mail for ${account}; it needs connecting`);
          return Response.json({ ok: true, ignored: "needs_connecting" });
        }
        console.error(`[mail] failed to process new mail for ${account}`, error);
        return Response.json({ ok: false, error: "processing_failed" }, { status: 500 });
      }
    }),
  ],
});
