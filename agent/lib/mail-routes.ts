import { randomUUID } from "node:crypto";

import type { SessionAuthContext } from "eve/context";
import type { JWTVerifyGetKey } from "jose";

import { GoogleNeedsConnectingError, type GoogleOwner } from "#lib/google.js";
import {
  coalescedMailRun,
  mailAuth,
  MailboxStateConflict,
  mailRunSchema,
  newEmailMessage,
  processMailbox,
  takeDailyMailRun,
  unknownMailboxKey,
  unknownMailboxTtlSeconds,
  type MailboxReader,
  type MailboxStateStore,
} from "#lib/new-mail.js";
import { isAuthenticPush, parseMailboxNotification } from "#lib/pubsub-push.js";
import { parseJson } from "#lib/qstash.js";
import type { SharedCache } from "#lib/shared-cache.js";

const queuedMarkerSlackSeconds = 60;

export interface MailPushDeps {
  readonly audience: string;
  readonly serviceAccount: string | undefined;
  readonly keys: () => JWTVerifyGetKey;
  readonly cache: SharedCache;
  readonly today: () => string;
  readonly now?: () => Date;
  publish(run: ReturnType<typeof coalescedMailRun>): Promise<void>;
}

export function mailPushHandler(deps: MailPushDeps) {
  return async (request: Request): Promise<Response> => {
    if (!deps.serviceAccount) {
      console.warn("[mail] rejected a push; GOOGLE_PUSH_SERVICE_ACCOUNT is not set");
      return Response.json({ ok: false, error: "not_configured" }, { status: 401 });
    }
    const authentic = await isAuthenticPush(request.headers.get("authorization"), {
      audience: deps.audience,
      serviceAccount: deps.serviceAccount,
      keys: deps.keys(),
    });
    if (!authentic) {
      console.warn("[mail] rejected a push without a valid Pub/Sub token");
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    // Acknowledged anyway: Pub/Sub would redeliver a malformed message until it expires.
    const notification = parseMailboxNotification(await request.json().catch(() => null));
    if (!notification) {
      console.warn("[mail] ignoring a malformed push; is Pub/Sub payload unwrapping on?");
      return Response.json({ ok: true, ignored: "invalid_payload" });
    }

    // A mailbox Adam no longer knows (a watch that outlived its account) costs no QStash message.
    if (await deps.cache.get(unknownMailboxKey(notification.emailAddress))) {
      return Response.json({ ok: true, ignored: "unknown_mailbox" });
    }

    const run = coalescedMailRun(notification.emailAddress, deps.now?.());
    const queuedKey = `mail-queued:${run.deduplicationId}`;
    if (await deps.cache.get(queuedKey)) return Response.json({ ok: true, coalesced: true });
    if (!(await takeDailyMailRun(deps.cache, run.body.emailAddress, deps.today()))) {
      return Response.json({ ok: true, ignored: "daily_cap" });
    }

    try {
      await deps.publish(run);
    } catch (error) {
      console.error("[mail] failed to queue a mailbox run", error);
      return Response.json({ ok: false, error: "publish_failed" }, { status: 500 });
    }
    await deps.cache.set(queuedKey, true, run.delaySeconds + queuedMarkerSlackSeconds);
    return Response.json({ ok: true });
  };
}

export interface MailHome {
  readonly owner: GoogleOwner;
  deliver(message: string, auth: SessionAuthContext): Promise<void>;
}

export interface MailRunDepsForRoute {
  readonly store: MailboxStateStore;
  readonly cache: SharedCache;
  readonly timeContext: () => string;
  readonly now?: () => number;
  verify(request: Request, body: string): Promise<boolean>;
  accountWithAddress(owner: GoogleOwner, address: string): Promise<string | null>;
  isListed(owner: GoogleOwner, account: string): Promise<boolean>;
  reader(owner: GoogleOwner, account: string): MailboxReader;
}

export function mailRunHandler(deps: MailRunDepsForRoute) {
  return async (request: Request, home: () => Promise<MailHome | null>): Promise<Response> => {
    const body = await request.text();
    if (!(await deps.verify(request, body))) {
      return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
    }

    const parsed = mailRunSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      console.warn("[mail] rejected malformed mailbox run");
      return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
    }

    const target = await home();
    if (!target) {
      console.warn("[mail] skipping new mail; no home delivery target is stored");
      return Response.json({ ok: true, ignored: "no_home_target" });
    }
    const { owner } = target;

    let account: string | null = null;
    try {
      account = await deps.accountWithAddress(owner, parsed.data.emailAddress);
      if (!account) {
        await deps.cache.set(unknownMailboxKey(parsed.data.emailAddress), true, unknownMailboxTtlSeconds);
        console.warn("[mail] skipping new mail; no connected account has the pushed address");
        return Response.json({ ok: true, ignored: "unknown_mailbox" });
      }

      const mailbox = account;
      const outcome = await processMailbox(mailbox, {
        store: deps.store,
        cache: deps.cache,
        mailbox: deps.reader(owner, mailbox),
        claimId: request.headers.get("upstash-message-id") ?? randomUUID(),
        emailAddress: parsed.data.emailAddress,
        isListed: () => deps.isListed(owner, mailbox),
        ...(deps.now ? { now: deps.now } : {}),
        deliver: (emails) => target.deliver(newEmailMessage(mailbox, emails, deps.timeContext()), mailAuth(owner, mailbox)),
      });
      console.log(`[mail] ${mailbox}: ${JSON.stringify(outcome)}`);
      // A live lease means another run is delivering; 409 has QStash retry once it settles.
      if (outcome.kind === "leased") return Response.json({ ok: false, ...outcome }, { status: 409 });
      return Response.json({ ok: true, ...outcome });
    } catch (error) {
      if (error instanceof MailboxStateConflict) {
        return Response.json({ ok: false, error: "busy" }, { status: 409 });
      }
      if (error instanceof GoogleNeedsConnectingError) {
        console.warn(`[mail] skipping new mail for ${account ?? "a mailbox"}; it needs connecting`);
        return Response.json({ ok: true, ignored: "needs_connecting" });
      }
      console.error(`[mail] failed to process new mail for ${account ?? "a mailbox"}`, error);
      return Response.json({ ok: false, error: "processing_failed" }, { status: 500 });
    }
  };
}
