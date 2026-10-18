import { defineEval } from "eve/evals";

import { formatUserDateTime } from "#lib/time.js";
import { debriefMessage } from "#lib/workouts.js";
import { debriefWithNextSession } from "#evals/workouts/debriefs.js";

const threeHours = 3 * 60 * 60;
const quarterHour = 15 * 60;

export default defineEval({
  description:
    "Workout debrief: a concrete next-session time schedules a reminder 15 minutes before it.",
  tags: ["workouts"],
  async test(t) {
    const sessionStart = new Date(Date.now() + threeHours * 1000);
    await t.send(
      debriefMessage(
        debriefWithNextSession(`Lower B | ${formatUserDateTime(sessionStart)}`),
      ),
    );
    t.succeeded();
    t.calledTool("schedule_reminder", {
      count: 1,
      input: {
        delaySeconds: (seconds) =>
          Math.abs(Number(seconds) - (threeHours - quarterHour)) <= 180,
      },
    });
  },
});
