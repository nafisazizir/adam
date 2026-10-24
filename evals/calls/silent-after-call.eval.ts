import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { callEnded } from "#evals/calls/fixtures.js";

const silent = satisfies((reply: string) => reply.trim() === "", "an empty reply");

export default defineEval({
  description: "Call ended: a call with nothing owed joins the history without a text recap.",
  tags: ["calls"],
  async test(t) {
    const turn = await t.send(callEnded());
    t.succeeded();
    t.calledTool("stay_silent");
    t.check(turn.message ?? "", silent);
  },
});
