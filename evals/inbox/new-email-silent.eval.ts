import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { newEmailMessage } from "#lib/new-mail.js";
import { currentTimeContext } from "#lib/time.js";
import { newsletters } from "#evals/inbox/new-mail.js";

const silent = satisfies((reply: string) => reply.trim() === "", "an empty reply");

// Run with side effects disabled, in case a failing run schedules or starts something:
//   QSTASH_TOKEN=eval-disabled DEVIN_API_KEY= DEVIN_ORG_ID= pnpm eve eval inbox/new-email-silent
export default defineEval({
  description: "New email: a newsletter, a receipt and a CI notice get no text at all.",
  tags: ["inbox"],
  async test(t) {
    const turn = await t.send(newEmailMessage("personal", newsletters, currentTimeContext()));
    t.succeeded();
    t.calledTool("stay_silent");
    for (const tool of ["schedule_reminder", "start_coding_session", "message_coding_session", "merge_pull_request"]) {
      t.notCalledTool(tool);
    }
    t.check(turn.message ?? "", silent);
  },
});
