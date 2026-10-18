import { defineEval } from "eve/evals";

import { formatUserDateTime } from "#lib/time.js";
import { debriefMessage } from "#lib/workouts.js";
import { debriefWithNextSession } from "#evals/workouts/debriefs.js";

const tenMinutes = 10 * 60 * 1000;

export default defineEval({
  description: "Workout debrief: a next session less than 20 minutes away schedules no reminder.",
  tags: ["workouts"],
  async test(t) {
    const sessionStart = new Date(Date.now() + tenMinutes);
    await t.send(
      debriefMessage(debriefWithNextSession(`Lower B | ${formatUserDateTime(sessionStart)}`)),
    );
    t.succeeded();
    t.notCalledTool("schedule_reminder");
  },
});
