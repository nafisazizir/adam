import { defineSchedule } from "eve/schedules";

import { dailyCron } from "#lib/cron.js";
import { runDueRoutines } from "#lib/routine-runner.js";
import { userTimeZone } from "#lib/time.js";

// A safety net for a lost timer: an overdue routine is skipped and re-armed for its next run.
export default defineSchedule({
  cron: dailyCron({ hour: 3 }, userTimeZone),
  async run({ to }) {
    await runDueRoutines(to);
  },
});
