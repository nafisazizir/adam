import { defineEval } from "eve/evals";

import { debriefMessage } from "#lib/workouts.js";
import { debriefWithNextSession } from "#evals/workouts/debriefs.js";

export default defineEval({
  description: "Workout debrief: an unscheduled next session schedules no reminder.",
  tags: ["workouts"],
  async test(t) {
    await t.send(debriefMessage(debriefWithNextSession("Lower B | unscheduled")));
    t.succeeded();
    t.calledTool("schedule_reminder", { count: 0 });
  },
});
