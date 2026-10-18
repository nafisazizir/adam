import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { callStarted } from "#evals/calls/fixtures.js";

const MAX_WORDS = 6;

const oneShortLine = satisfies((reply: string) => {
  const words = reply.trim().split(/\s+/u).filter(Boolean).length;
  return words > 0 && words <= MAX_WORDS && !reply.includes("\n");
}, `one line of at most ${MAX_WORDS} words`);

export default defineEval({
  description: "Call started: Adam texts one short line, so the owner notices a call they did not make.",
  tags: ["calls"],
  async test(t) {
    const turn = await t.send(callStarted());
    t.succeeded();
    t.notCalledTool("stay_silent");
    t.check(turn.message ?? "", oneShortLine);
  },
});
