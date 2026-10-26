import { defineEval } from "eve/evals";

import { currentTimeContext } from "#lib/time.js";

// An eval turn is not the owner's chat, so a ringing reminder is refused before it is published:
//   ELEVENLABS_API_KEY= CALLS_PHONE_NUMBER= CALLS_TOOL_SECRET= QSTASH_TOKEN=eval-disabled pnpm eve eval reminders/ring-wake-up
export default defineEval({
  description: "Reminders: 'call me at 6 to wake me up' is a reminder that rings, at that clock time.",
  tags: ["reminders"],
  async test(t) {
    await t.send(`${currentTimeContext()}\n\ncall me tomorrow at 6am to wake me up`);
    t.calledTool("schedule_reminder", {
      status: "failed",
      input: { ring: true, at: (value) => typeof value === "string" && value.endsWith("T06:00") },
    });
    t.notCalledTool("call_owner");
  },
});
