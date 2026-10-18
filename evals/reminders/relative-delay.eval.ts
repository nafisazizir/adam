import { defineEval } from "eve/evals";

import { currentTimeContext } from "#lib/time.js";

// schedule_reminder publishes a real QStash message unless publishing is disabled, so run with
//   QSTASH_TOKEN=eval-disabled pnpm eve eval reminders
// The publish then fails safely and the eval asserts on the tool input only.
export default defineEval({
  description: "Reminders: 'in 20 minutes' is a 1200 second delay, not a clock time.",
  tags: ["reminders"],
  async test(t) {
    await t.send(`${currentTimeContext()}\n\nremind me in 20 minutes to move the laundry`);
    t.calledTool("schedule_reminder", {
      status: "failed",
      input: { delaySeconds: 1200, at: (value) => value === undefined },
    });
  },
});
