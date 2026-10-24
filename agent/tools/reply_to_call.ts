import { defineTool } from "eve/tools";
import { z } from "zod";

import { isLiveCallTurn } from "#lib/calls.js";

export default defineTool({
  description:
    "Say something out loud to the user on the phone call they are on right now. Only for a " +
    "<call_request> turn: call it once, with one to three short spoken sentences, no markdown, " +
    "lists or links. It does not end your turn: afterwards text them anything better read than " +
    "heard, such as photos or links, as your normal reply, or call stay_silent.",
  inputSchema: z.object({
    speech: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .describe("What to say, written the way you would say it out loud."),
  }),
  async execute(_input, ctx) {
    if (!isLiveCallTurn(ctx.session.auth.current)) {
      return {
        spoken: false,
        error: "There is no live call in this turn, so nothing was said. Text the user instead, or stay silent.",
      };
    }
    return { spoken: true };
  },
});
