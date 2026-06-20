import { defineTool } from "eve/tools";
import { z } from "zod";

import { cancelReminder } from "#lib/qstash.js";
import { scheduledReminders } from "#lib/reminders.js";

export default defineTool({
  description:
    "Cancel a previously scheduled reminder by its id. " +
    "Call list_reminders first to find the id that matches what the user wants to cancel.",
  inputSchema: z.object({
    id: z
      .string()
      .min(1)
      .describe("The reminder id from schedule_reminder or list_reminders."),
  }),
  async execute({ id }) {
    await cancelReminder(id);
    scheduledReminders.update((list) => list.filter((reminder) => reminder.id !== id));

    return { id, cancelled: true };
  },
});
