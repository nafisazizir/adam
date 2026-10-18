import { defineEval } from "eve/evals";

import { currentTimeContext } from "#lib/time.js";

// cancel_reminder talks to QStash unless it is disabled, so run with
//   QSTASH_TOKEN=eval-disabled pnpm eve eval reminders
// The call then fails safely and the eval asserts on the tool input only. A session has no scheduled
// reminders to list (scheduling fails too), so it tells the model to cancel directly and checks id pass-through only.
export default defineEval({
  description: "Reminders: cancelling a reminder by id calls cancel_reminder with that id.",
  tags: ["reminders"],
  async test(t) {
    await t.send(`${currentTimeContext()}\n\ncancel reminder msg_eval_0001. this is a fresh chat so list_reminders will come back empty, that's expected, the id is right: call cancel_reminder with it directly`);
    t.calledTool("cancel_reminder", { status: "failed", input: { id: "msg_eval_0001" } });
    t.notCalledTool("schedule_reminder");
  },
});
