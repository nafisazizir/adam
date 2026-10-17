import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { mergedUpdate } from "#evals/coding/updates.js";
import { assertHouseStyle } from "#evals/personality/style.js";
import { codingUpdateMessage } from "#lib/coding-sessions.js";

const MAX_WORDS = 15;

const brief = satisfies(
  (reply: string) => reply.split(/\s+/u).filter(Boolean).length <= MAX_WORDS,
  `at most ${MAX_WORDS} words`,
);

export default defineEval({
  description: "Coding session update: a merge the user asked for is confirmed in a few words.",
  tags: ["coding"],
  async test(t) {
    const turn = await t.send(codingUpdateMessage(mergedUpdate));
    t.succeeded();
    t.usedNoTools();
    const reply = turn.message ?? "";
    t.check(reply, brief);
    assertHouseStyle(t, reply);
    t.judge("Tells the user the pull request is merged, briefly and casually, without recapping the work.").atLeast(0.7);
  },
});
