import { defineChannel, POST } from "eve/channels";

import {
  codingSessionAuth,
  codingUpdateFor,
  codingUpdateMessage,
  codingUpdateSchema,
  nextWatchTick,
  publishCodingUpdate,
  watchCodingSession,
  watchTickSchema,
  type WatchTick,
} from "#lib/coding-sessions.js";
import { homeDelivery } from "#lib/delivery.js";
import { DevinApiError, getCodingSession, listCodingSessionMessages } from "#lib/devin.js";
import { codingSessionsNotifyPath, codingSessionsWatchPath, env } from "#lib/env.js";
import { hasValidCallbackSignature, parseJson } from "#lib/qstash.js";

async function checkSession(tick: WatchTick) {
  const [session, messages] = await Promise.all([
    getCodingSession(tick.sessionId),
    listCodingSessionMessages(tick.sessionId),
  ]);

  const found = codingUpdateFor(session, messages);
  let notified = tick.notified;
  if (found && found.key !== tick.notified) {
    try {
      await publishCodingUpdate(found.update, found.key);
      notified = found.key;
    } catch (error) {
      console.error(`[coding-sessions] failed to queue an update for ${tick.sessionId}`, error);
    }
  }

  return { session, notified, pending: found !== null && found.key !== notified };
}

export default defineChannel({
  routes: [
    POST(codingSessionsWatchPath, async (request) => {
      const body = await request.text();
      if (!(await hasValidCallbackSignature(request, body, env.codingSessionsWatchUrl))) {
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }

      const parsed = watchTickSchema.safeParse(parseJson(body));
      if (!parsed.success) {
        console.warn("[coding-sessions] rejected malformed watch tick");
        return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
      }

      const tick = parsed.data;
      let check: Awaited<ReturnType<typeof checkSession>> | null = null;
      try {
        check = await checkSession(tick);
      } catch (error) {
        console.error(`[coding-sessions] failed to check ${tick.sessionId}`, error);
        if (error instanceof DevinApiError && error.isPermanent) {
          return Response.json({ ok: true, watching: false });
        }
      }

      const next = nextWatchTick(tick, check);
      if (!next) {
        console.log(`[coding-sessions] stopped watching ${tick.sessionId}`);
        return Response.json({ ok: true, watching: false });
      }

      try {
        await watchCodingSession(next, check?.session ?? null);
      } catch (error) {
        console.error(`[coding-sessions] failed to schedule the next check of ${tick.sessionId}`, error);
        return Response.json({ ok: false, error: "publish_failed" }, { status: 500 });
      }

      return Response.json({ ok: true, watching: true });
    }),
    POST(codingSessionsNotifyPath, async (request, { to }) => {
      const body = await request.text();
      if (!(await hasValidCallbackSignature(request, body, env.codingSessionsNotifyUrl))) {
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }

      const parsed = codingUpdateSchema.safeParse(parseJson(body));
      if (!parsed.success) {
        console.warn("[coding-sessions] rejected malformed update");
        return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
      }

      const update = parsed.data;
      const home = await homeDelivery();
      if (!home) {
        console.warn("[coding-sessions] skipping update; no home delivery target is stored");
        return Response.json({ ok: true, ignored: "no_home_target" });
      }
      const { channel, target, owner } = home;

      try {
        await channel.deliver({
          to,
          message: codingUpdateMessage(update),
          target,
          auth: codingSessionAuth(update.sessionId, owner),
          turnPolicy: "queue",
        });
      } catch (error) {
        console.error(`[coding-sessions] failed to deliver update for ${update.sessionId}`, error);
        return Response.json({ ok: false, error: "delivery_failed" }, { status: 500 });
      }

      console.log(`[coding-sessions] delivered ${update.state} for ${update.sessionId}`);
      return Response.json({ ok: true });
    }),
  ],
});
