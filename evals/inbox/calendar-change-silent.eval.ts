import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { calendarChangeMessage } from "#lib/calendar-changes.js";
import { currentTimeContext } from "#lib/time.js";
import { routineChanges } from "#evals/inbox/calendar-changes.js";

const silent = satisfies((reply: string) => reply.trim() === "", "an empty reply");

// The trigger is built in process and sent to the eval session only, so nothing reaches the owner.
// Run with side effects disabled, in case a failing run schedules or starts something:
//   QSTASH_TOKEN=eval-disabled DEVIN_API_KEY= DEVIN_ORG_ID= pnpm eve eval inbox/calendar-change-silent
export default defineEval({
  description: "Calendar change: one guest declining next week's team sync and a webinar moved 15 minutes get no text.",
  tags: ["inbox"],
  async test(t) {
    const turn = await t.send(calendarChangeMessage("work", routineChanges, currentTimeContext()));
    t.succeeded();
    t.calledTool("stay_silent");
    for (const tool of ["create_event", "update_event", "schedule_reminder", "start_coding_session", "merge_pull_request"]) {
      t.notCalledTool(tool);
    }
    t.check(turn.message ?? "", silent);
  },
});
