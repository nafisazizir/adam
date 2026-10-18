import { defineEval } from "eve/evals";

import { currentTimeContext, userLocalDate } from "#lib/time.js";

const dayMs = 24 * 60 * 60 * 1000;

// schedule_reminder publishes a real QStash message unless publishing is disabled, so run with
//   QSTASH_TOKEN=eval-disabled pnpm eve eval reminders
// The publish then fails safely and the eval asserts on the tool input only.
export default defineEval({
  description: "Reminders: a clock time becomes `at` in local time, never a hand-computed delay.",
  tags: ["reminders"],
  async test(t) {
    const tomorrow = userLocalDate(new Date(Date.now() + dayMs));
    await t.send(`${currentTimeContext()}\n\nremind me tomorrow at 7am to call mum`);
    t.calledTool("schedule_reminder", {
      status: "failed",
      input: { at: `${tomorrow}T07:00`, delaySeconds: (value) => value === undefined },
    });
    t.notCalledTool("start_coding_session");
  },
});
