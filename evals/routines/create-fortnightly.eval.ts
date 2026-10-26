import { defineEval } from "eve/evals";

import { currentTimeContext } from "#lib/time.js";

// An eval turn is not the owner's chat, so create_routine refuses before it touches Blob or QStash.
export default defineEval({
  description: "Routines: 'every second sunday at 6pm' is a fortnightly weekly rule on Sunday at 18:00, not a reminder.",
  tags: ["routines"],
  async test(t) {
    await t.send(
      `${currentTimeContext()}\n\nevery second sunday at 6pm do a health checkpoint with me: how im tracking on my goals and whether we should shift the plan`,
    );
    t.calledTool("create_routine", {
      status: "failed",
      input: {
        schedule: (value: unknown) => {
          const rule = value as { every?: string; interval?: number; weekdays?: string[]; time?: string };
          return (
            rule.every === "weeks" &&
            rule.interval === 2 &&
            rule.time === "18:00" &&
            JSON.stringify(rule.weekdays) === JSON.stringify(["sun"])
          );
        },
      },
    });
    t.notCalledTool("schedule_reminder");
  },
});
