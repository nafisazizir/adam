import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { calendarChangeMessage } from "#lib/calendar-changes.js";
import { currentTimeContext } from "#lib/time.js";
import { tonightCancelled } from "#evals/inbox/calendar-changes.js";

const short = satisfies((reply: string) => reply.trim().length > 0 && reply.length <= 280, "one short message");

// The trigger is built in process and sent to the eval session only, so nothing reaches the owner.
// Run with side effects disabled, in case a failing run schedules or starts something:
//   QSTASH_TOKEN=eval-disabled DEVIN_API_KEY= DEVIN_ORG_ID= pnpm eve eval inbox/calendar-change-tonight
export default defineEval({
  description: "Calendar change: a friend cancelling tonight's dinner gets one short text; a routine decline does not.",
  tags: ["inbox"],
  async test(t) {
    const turn = await t.send(calendarChangeMessage("personal", tonightCancelled, currentTimeContext()));
    t.succeeded();
    t.notCalledTool("stay_silent");
    for (const tool of [
      "draft_email",
      "create_event",
      "update_event",
      "schedule_reminder",
      "start_coding_session",
      "merge_pull_request",
    ]) {
      t.notCalledTool(tool);
    }
    t.check(turn.message ?? "", short);
    t.judge(
      "One short text telling the user that Mia cancelled tonight's dinner at Bar Rosa. It does not mention the book club decline, does not paste the event, and does not claim to have changed, rescheduled or replied to anything.",
    ).atLeast(0.7);
  },
});
