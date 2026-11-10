import { defineChannel, POST } from "eve/channels";

import { relayCallEnded, relayCallRequest } from "#lib/call-relay.js";
import { env, vapiEventsPath, vapiToolsPath } from "#lib/env.js";
import { parseJson } from "#lib/qstash.js";
import { parseVapiEvent, parseVapiToolCalls, vapiToolResults } from "#lib/vapi.js";
import { hasCallsSecret } from "#lib/voice.js";

const notConfigured = () => Response.json({ ok: false, error: "vapi_not_configured" }, { status: 503 });
const unauthorized = () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
const invalidPayload = () => Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });

const notOnThisLine = "Sorry, I can't help with that on this line.";

// Vapi is a second front end for the same calls: what's asked and how it ended reach the owner's
// one thread through the relay ElevenLabs uses. Adam sets the secret header on every call it places.
function authorized(request: Request): Response | null {
  const secret = env.CALLS_TOOL_SECRET;
  if (!env.VAPI_API_KEY || !secret) return notConfigured();
  return hasCallsSecret(request, secret) ? null : unauthorized();
}

export default defineChannel({
  routes: [
    POST(vapiToolsPath, async (request, args) => {
      const refused = authorized(request);
      if (refused) return refused;

      const toolCalls = parseVapiToolCalls(parseJson(await request.text()));
      if (!toolCalls) return invalidPayload();

      const results = [];
      for (const { toolCallId, ask } of toolCalls) {
        if (!ask) {
          results.push({ toolCallId, result: notOnThisLine });
          continue;
        }
        const relayed = await relayCallRequest(ask, args);
        results.push({ toolCallId, result: relayed.ok ? relayed.speech : notOnThisLine });
      }
      return Response.json(vapiToolResults(results));
    }),

    POST(vapiEventsPath, async (request, args) => {
      const refused = authorized(request);
      if (refused) return refused;

      const event = parseVapiEvent(parseJson(await request.text()));
      if (event.kind === "ignored") return Response.json({ ok: true, ignored: "event_type" });
      if (event.kind === "invalid") return invalidPayload();

      const relayed = await relayCallEnded(event.ended, args);
      return Response.json(relayed.body, { status: relayed.status });
    }),
  ],
});
