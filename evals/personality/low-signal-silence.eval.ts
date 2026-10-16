import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { assertHouseStyle } from "#evals/personality/style.js";

const MAX_WORDS = 6;

const minimal = satisfies(
  (reply: string) => reply.split(/\s+/u).filter(Boolean).length <= MAX_WORDS,
  `nothing, or at most ${MAX_WORDS} words`,
);

export default defineEval({
  description: "Right to silence: a low-signal acknowledgement gets a couple of words or nothing at all.",
  tags: ["personality"],
  async test(t) {
    const turn = await t.send("cool, thanks 🙏");
    t.succeeded();
    const reply = turn.message ?? "";
    t.check(reply, minimal);
    assertHouseStyle(t, reply);
    t.judge(
      "Keeps it minimal: nothing at all, or at most a brief acknowledgement. Does NOT restate what was discussed, add a status report, or pad the reply with extra offers.",
    ).atLeast(0.7);
  },
});
