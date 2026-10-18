// Side effect: schedule_reminder is not stubbed, so this publishes a real QStash reminder to BASE_URL; cancel it after running.
import { defineEval } from "eve/evals";

import { debriefMessage } from "#lib/workouts.js";
import { debriefWithNextSession, localDateTimeIn } from "#evals/workouts/debriefs.js";

const threeHours = 3 * 60 * 60 * 1000;

export default defineEval({
  description:
    "Workout debrief: a concrete next-session time schedules a reminder 15 minutes before it, silently.",
  tags: ["workouts"],
  async test(t) {
    const sessionStart = localDateTimeIn(threeHours);
    await t.send(debriefMessage(debriefWithNextSession(`Lower B | ${sessionStart}`)));
    t.succeeded();
    t.calledTool("stay_silent");
    t.calledTool("schedule_reminder", {
      count: 1,
      input: { at: sessionStart, leadMinutes: 15 },
    });
  },
});
