import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { newEmailMessage } from "#lib/new-mail.js";
import { currentTimeContext } from "#lib/time.js";
import { timeSensitive } from "#evals/inbox/new-mail.js";

const short = satisfies((reply: string) => reply.trim().length > 0 && reply.length <= 280, "one short message");

// Run with side effects disabled, in case a failing run schedules or starts something:
//   QSTASH_TOKEN=eval-disabled DEVIN_API_KEY= DEVIN_ORG_ID= pnpm eve eval inbox/new-email-time-sensitive
export default defineEval({
  description: "New email: a friend who needs a yes tonight on a changed dinner time gets one short text.",
  tags: ["inbox"],
  async test(t) {
    const turn = await t.send(newEmailMessage("personal", timeSensitive, currentTimeContext()));
    t.succeeded();
    t.notCalledTool("stay_silent");
    for (const tool of ["schedule_reminder", "start_coding_session", "message_coding_session", "merge_pull_request"]) {
      t.notCalledTool(tool);
    }
    t.check(turn.message ?? "", short);
    t.judge(
      "One short text telling the user that Mia wants to move tomorrow's dinner to 6:30 and needs their answer tonight. It does not mention the newsletter, does not paste the email, and does not claim to have replied, scheduled or done anything.",
    ).atLeast(0.7);
  },
});
