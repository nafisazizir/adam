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
} from "#lib/coding-sessions.js";
import { homeDelivery } from "#lib/delivery.js";
import {
  DevinApiError,
  getCodingSession,
  listCodingSessionMessages,
  type CodingSession,
} from "#lib/devin.js";
import { codingSessionsNotifyPath, codingSessionsWatchPath, env } from "#lib/env.js";
import { hasValidCallbackSignature } from "#lib/qstash.js";

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
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
      let session: CodingSession | null = null;
      try {
        session = await getCodingSession(tick.sessionId);
        const found = codingUpdateFor(session, await listCodingSessionMessages(tick.sessionId));
        if (found) await publishCodingUpdate(found.update, found.deduplicationId);
      } catch (error) {
        console.error(`[coding-sessions] failed to check ${tick.sessionId}`, error);
        if (error instanceof DevinApiError && error.isPermanent) {
          return Response.json({ ok: true, watching: false });
        }
        // Anything else may be a passing outage, which should cost one tick, not the watch.
      }

      const next = nextWatchTick(tick, session);
      if (!next) {
        console.log(`[coding-sessions] stopped watching ${tick.sessionId}`);
        return Response.json({ ok: true, watching: false });
      }

      try {
        await watchCodingSession(tick.sessionId, next);
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
