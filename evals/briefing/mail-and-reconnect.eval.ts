import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { googleBriefingMessage, needsThem } from "#evals/briefing/google.js";

const short = satisfies((reply: string) => reply.trim().length > 0 && reply.length <= 320, "one short message");

// Run with side effects disabled, in case a failing run schedules or starts something:
//   QSTASH_TOKEN=eval-disabled DEVIN_API_KEY= DEVIN_ORG_ID= pnpm eve eval briefing
export default defineEval({
  description:
    "Morning briefing: a friend's email that needs an answer tonight and a Google account that needs connecting get one short text, without a recap of the ordinary calendar.",
  tags: ["briefing"],
  async test(t) {
    const turn = await t.send(await googleBriefingMessage(needsThem));
    t.succeeded();
    t.notCalledTool("stay_silent");
    for (const tool of [
      "schedule_reminder",
      "start_coding_session",
      "message_coding_session",
      "merge_pull_request",
      "draft_email",
      "connect_google_account",
    ]) {
      t.notCalledTool(tool);
    }
    t.check(turn.message ?? "", short);
    t.judge(
      "One short text that tells the user Mia wants to move tomorrow's dinner to 6:30 and needs their answer tonight, and that their uni Google account needs connecting again (they can text for a link). It does not list the standup, focus time or 1:1, does not mention the newsletter, does not paste the email, and does not claim to have replied or done anything.",
    ).atLeast(0.7);
  },
});
