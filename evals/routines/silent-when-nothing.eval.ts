import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { dueRoutine, routineTurn } from "#evals/routines/routines.js";

const silent = satisfies((reply: string) => reply.trim() === "", "an empty reply");

export default defineEval({
  description: "Routines: a routine whose condition is not met in this conversation stays silent.",
  tags: ["routines"],
  async test(t) {
    await t.send("ok heading into back to back meetings, chat later");
    const turn = await t.send(
      routineTurn(
        dueRoutine({
          name: "sick-day check",
          instruction:
            "If I've said in this chat that I'm sick or run down, check I'm drinking water and resting. Otherwise say nothing.",
          schedule: { every: "days", interval: 1, time: "14:00" },
        }),
      ),
    );
    t.calledTool("stay_silent");
    t.calledTool("note_routine_run", { status: "failed", input: { id: "routine_eval0001", notified: false } });
    t.check(turn.message ?? "", silent);
  },
});
