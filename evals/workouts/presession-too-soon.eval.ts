import { defineEval } from "eve/evals";

import { debriefMessage } from "#lib/workouts.js";
import { debriefWithNextSession, localDateTimeIn } from "#evals/workouts/debriefs.js";

const tenMinutes = 10 * 60 * 1000;

export default defineEval({
  description: "Workout debrief: a next session too close to remind schedules no reminder.",
  tags: ["workouts"],
  async test(t) {
    await t.send(
      debriefMessage(debriefWithNextSession(`Lower B | ${localDateTimeIn(tenMinutes)}`)),
    );
    t.succeeded();
    t.calledTool("schedule_reminder", {
      count: 0,
      output: (output) => !(output as { skipped?: string } | null)?.skipped,
    });
  },
});
