import { defineEval } from "eve/evals";

import { currentTimeContext } from "#lib/time.js";

// cancel_reminder talks to QStash unless it is disabled, so run with
//   QSTASH_TOKEN=eval-disabled pnpm eve eval reminders
// The call then fails safely and the eval asserts on the tool input only.
export default defineEval({
  description: "Reminders: cancelling a reminder by id calls cancel_reminder with that id.",
  tags: ["reminders"],
  async test(t) {
    await t.send(`${currentTimeContext()}\n\ncancel reminder msg_eval_0001 right now, it's the id from your last list so skip checking the list`);
    t.calledTool("cancel_reminder", { status: "failed", input: { id: "msg_eval_0001" } });
    t.notCalledTool("schedule_reminder");
  },
});
