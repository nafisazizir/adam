import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { debriefMessage } from "#lib/workouts.js";
import { onPlanRunDebrief } from "#evals/workouts/debriefs.js";

const silent = satisfies((reply: string) => reply.trim() === "", "an empty reply");

export default defineEval({
  description: "Workout debrief: an unremarkable session that went to plan gets no text at all.",
  tags: ["workouts"],
  async test(t) {
    await t.send(debriefMessage(onPlanRunDebrief));
    t.succeeded();
    t.usedNoTools();
    t.check(t.reply ?? "", silent);
  },
});
