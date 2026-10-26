import { defineTool } from "eve/tools";
import { z } from "zod";

import { blobClaimStore } from "#lib/claim-store.js";
import { knownOwner } from "#lib/known-owner.js";
import { configuredOutboundLine, ringOnceKey, ringOwner, ringOwnerRefusal } from "#lib/ring-owner.js";
import { placeOutboundCall } from "#lib/voice.js";

export default defineTool({
  description:
    "Ring the user's phone. The voice assistant opens with your reason, and the call joins this " +
    "thread like any call they make to you: their requests reach you as <call_request>. Only when " +
    "they ask you to call them in chat, or when a reminder they asked to be rung for is due; " +
    "anywhere else it refuses. It returns once the phone is ringing, not when they answer.",
  inputSchema: z.object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe("One or two short spoken sentences saying why you're calling, the way you'd open the call."),
  }),
  async execute({ reason }, ctx) {
    const auth = ctx.session.auth.current;
    const refusal = ringOwnerRefusal(auth);
    if (refusal) return { ringing: false, error: refusal };

    const deps = { line: configuredOutboundLine(), owner: knownOwner, budget: blobClaimStore, place: placeOutboundCall };
    const outcome = await ringOwner(reason, deps, ringOnceKey(auth));
    if (!outcome.rung) return { ringing: false, error: outcome.error };
    return { ringing: true, conversationId: outcome.conversationId };
  },
});
