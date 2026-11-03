import { defineChannel, POST } from "eve/channels";

import { env, routinesRunPath } from "#lib/env.js";
import { hasValidCallbackSignature } from "#lib/qstash.js";
import { runDueRoutines } from "#lib/routine-runner.js";

// The body only names the instant; what is due is read from the routine store, so a stale or
// duplicate delivery finds nothing to run.
export default defineChannel({
  routes: [
    POST(routinesRunPath, async (request, { to }) => {
      const body = await request.text();
      if (!(await hasValidCallbackSignature(request, body, env.routinesRunUrl))) {
        return new Response("invalid signature", { status: 401 });
      }

      try {
        await runDueRoutines(to);
        return new Response("ok");
      } catch (error) {
        console.error("[routines] run failed", error);
        return new Response("run failed", { status: 500 });
      }
    }),
  ],
});
