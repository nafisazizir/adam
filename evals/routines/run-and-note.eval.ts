import { defineEval } from "eve/evals";

import { assertHouseStyle } from "#evals/personality/style.js";
import { dueRoutine, routineTurn } from "#evals/routines/routines.js";

// note_routine_run refuses an eval turn (it is neither a routine turn nor the owner's chat), so
// nothing is written; the eval asserts on its input and the text.
export default defineEval({
  description: "Routines: a due routine that always reports gets one short text in Adam's voice, and its run is noted.",
  tags: ["routines"],
  async test(t) {
    const turn = await t.send(
      routineTurn(
        dueRoutine({
          name: "run club pep talk",
          instruction: "Every Thursday before run club, text me one short line to get me out the door. Always send it.",
          schedule: { every: "weeks", interval: 1, weekdays: ["thu"], time: "17:00" },
          runs: [{ at: new Date(Date.now() - 7 * 86_400_000).toISOString(), note: "sent: 'shoes on, excuses off'", notified: true }],
        }),
      ),
    );
    t.notCalledTool("stay_silent");
    t.calledTool("note_routine_run", { status: "failed", input: { id: "routine_eval0001", notified: true } });
    for (const tool of ["create_routine", "update_routine", "delete_routine", "schedule_reminder"]) t.notCalledTool(tool);
    const reply = turn.message ?? "";
    assertHouseStyle(t, reply);
    t.judge(
      "One short casual line, like a friend nudging them out the door to run club. It does not repeat 'shoes on, excuses off', and it does not explain that it is a routine or mention schedules.",
    ).atLeast(0.7);
  },
});
