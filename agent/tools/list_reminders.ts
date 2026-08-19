import { defineTool } from "eve/tools";
import { z } from "zod";

import { scheduledReminders } from "#lib/reminders.js";
import { formatUserDateTime } from "#lib/time.js";

export default defineTool({
  description:
    "List the user's upcoming scheduled reminders, each with its id, message, and fire " +
    "time in the user's local time zone. " +
    "Call this before cancelling so you can match the user's request to the right id.",
  inputSchema: z.object({}),
  async execute() {
    const now = Date.now();
    const upcoming = scheduledReminders
      .get()
      .filter((reminder) => Date.parse(reminder.fireAt) > now);
    scheduledReminders.update(() => upcoming);

    return {
      reminders: upcoming.map((reminder) => ({
        id: reminder.id,
        message: reminder.message,
        fireAt: formatUserDateTime(new Date(reminder.fireAt)),
      })),
    };
  },
});
