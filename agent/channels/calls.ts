import { defineChannel, POST } from "eve/channels";

import { callBriefing, declinedCallBriefing, isOwnerCaller } from "#lib/calls.js";
import { describeCaller, noteCallStarted, relayCallEnded, relayCallRequest } from "#lib/call-relay.js";
import { callsAskPath, callsEndedPath, callsStartPath, env } from "#lib/env.js";
import { knownOwner } from "#lib/known-owner.js";
import { parseJson } from "#lib/qstash.js";
import { formatUserDateTime } from "#lib/time.js";
import {
  callReplyResponse,
  callStartResponse,
  hasCallsSecret,
  hasValidCallEndedSignature,
  parseCallEnded,
  parseCallRequest,
  parseCallStart,
} from "#lib/voice.js";
import { postCallWebhookSecret } from "#lib/voice-agent-store.js";

const notConfigured = () => Response.json({ ok: false, error: "calls_not_configured" }, { status: 503 });
const unauthorized = () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
const invalidPayload = () => Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });

// The production build's voice agent sync creates the post-call webhook and keeps its secret.
async function postCallSecretOrNull(): Promise<string | null> {
  try {
    return await postCallWebhookSecret();
  } catch (error) {
    console.warn("[calls] could not read the post-call webhook secret", error);
    return null;
  }
}

export default defineChannel({
  routes: [
    POST(callsStartPath, async (request, args) => {
      const secret = env.CALLS_TOOL_SECRET;
      if (!secret) return notConfigured();
      if (!hasCallsSecret(request, secret)) return unauthorized();

      const start = parseCallStart(parseJson(await request.text()));
      if (!start) return invalidPayload();

      const localTime = formatUserDateTime(new Date());
      if (!isOwnerCaller(start.callerNumber, await knownOwner())) {
        console.warn(`[calls] declined a call from ${describeCaller(start.callerNumber)}; not the owner`);
        return Response.json(callStartResponse(declinedCallBriefing(localTime)));
      }

      await noteCallStarted({ conversationId: start.conversationId ?? "unknown" }, args);
      return Response.json(callStartResponse(callBriefing(localTime)));
    }),

    POST(callsAskPath, async (request, args) => {
      const secret = env.CALLS_TOOL_SECRET;
      if (!secret) return notConfigured();
      if (!hasCallsSecret(request, secret)) return unauthorized();

      const ask = parseCallRequest(parseJson(await request.text()));
      if (!ask) return invalidPayload();

      const relayed = await relayCallRequest(ask, args);
      if (!relayed.ok) return Response.json({ ok: false, error: relayed.error }, { status: 403 });
      return Response.json(callReplyResponse(relayed.speech));
    }),

    POST(callsEndedPath, async (request, args) => {
      const secret = await postCallSecretOrNull();
      if (!secret) return notConfigured();

      const body = await request.text();
      if (!hasValidCallEndedSignature(request, body, secret)) return unauthorized();

      const parsed = parseCallEnded(parseJson(body));
      if (!parsed.ok) {
        return parsed.reason === "ignored" ? Response.json({ ok: true, ignored: "event_type" }) : invalidPayload();
      }

      const relayed = await relayCallEnded(parsed.ended, args);
      return Response.json(relayed.body, { status: relayed.status });
    }),
  ],
});
