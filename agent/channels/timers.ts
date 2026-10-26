import { defineChannel, POST } from "eve/channels";

import { env, timersHopPath } from "#lib/env.js";
import { hasValidCallbackSignature, parseJson } from "#lib/qstash.js";
import { hopSchema } from "#lib/timer.js";
import { timers } from "#lib/timers.js";

export default defineChannel({
  routes: [
    POST(timersHopPath, async (request) => {
      const body = await request.text();
      if (!(await hasValidCallbackSignature(request, body, env.timersHopUrl))) {
        return new Response("invalid signature", { status: 401 });
      }

      const parsed = hopSchema.safeParse(parseJson(body));
      if (!parsed.success) {
        console.warn("[timers] rejected malformed hop");
        return new Response("invalid payload", { status: 400 });
      }

      try {
        const outcome = await timers.hop(parsed.data, request.headers.get("upstash-message-id"));
        console.log(`[timers] ${parsed.data.id} ${outcome}`);
        return new Response("ok");
      } catch (error) {
        console.error(`[timers] could not forward ${parsed.data.id}`, error);
        return new Response("hop failed", { status: 500 });
      }
    }),
  ],
});
