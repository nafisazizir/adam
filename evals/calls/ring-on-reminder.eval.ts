import { defineEval } from "eve/evals";

import { dueReminderMessage } from "#lib/reminders.js";
import { currentTimeContext } from "#lib/time.js";

// call_owner refuses outside a real ringing reminder turn, and with calling unset it can't dial:
//   ELEVENLABS_API_KEY= CALLS_PHONE_NUMBER= CALLS_TOOL_SECRET= QSTASH_TOKEN=eval-disabled pnpm eve eval calls/ring-on-reminder
export default defineEval({
  description: "Calls: a reminder the user asked to be rung for makes Adam ring them, and text when the call can't go out.",
  tags: ["calls"],
  async test(t) {
    await t.send(`${currentTimeContext()}\n\n${dueReminderMessage("wake up, the airport shuttle leaves at 6:15", true)}`);
    t.succeeded();
    t.calledTool("call_owner", { input: { reason: (value) => typeof value === "string" && /shuttle|6:15/iu.test(value) } });
    t.notCalledTool("stay_silent");
    t.judge("Texts the user the reminder: wake up, the airport shuttle leaves at 6:15. Brief, in a casual voice.").atLeast(0.7);
  },
});
