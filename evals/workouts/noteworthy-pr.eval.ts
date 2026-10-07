import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { assertHouseStyle } from "#evals/personality/style.js";
import { squatPrDebrief } from "#evals/workouts/debriefs.js";
import { debriefMessage } from "#lib/workouts.js";

const MAX_LINES = 4;

const short = satisfies((reply: string) => {
  const lines = reply.split("\n").filter((line) => line.trim() !== "" && line.trim() !== "---");
  return lines.length >= 1 && lines.length <= MAX_LINES;
}, `non-empty, at most ${MAX_LINES} lines`);

export default defineEval({
  description: "Workout debrief: a PR with a clear thing to fix gets one short text covering both.",
  tags: ["workouts"],
  async test(t) {
    const turn = await t.send(debriefMessage(squatPrDebrief));
    t.succeeded();
    t.usedNoTools();
    const reply = turn.message ?? "";
    t.check(reply, short);
    assertHouseStyle(t, reply);
    t.judge(
      "Concretely names what went well (the 140 kg back squat PR or the rising squat trend) AND what to improve (the RDL sets falling apart, e.g. dropping weight to keep clean reps). It is a short casual text. It does NOT list a pile of stats, summarise a full analysis, include a link, mention Notion, or add generic encouragement or filler.",
    ).atLeast(0.7);
  },
});
