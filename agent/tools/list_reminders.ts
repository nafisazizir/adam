import { defineTool } from "eve/tools";
import { z } from "zod";

import { listUpcomingReminders } from "#lib/reminder-list.js";
import { blobReminderListStore } from "#lib/reminder-list-store.js";
import { formatUserDateTime } from "#lib/time.js";

export default defineTool({
  description:
    "List the user's upcoming scheduled reminders from every conversation, each with its id, message, and fire " +
    "time in the user's local time zone. " +
    "Call this before cancelling so you can match the user's request to the right id. " +
    "If it returns { unavailable: true } the list could not be read: say so rather than claiming there are none.",
  inputSchema: z.object({}),
  async execute() {
    const read = await listUpcomingReminders(blobReminderListStore, Date.now());
    if (read.status === "unavailable") {
      return { unavailable: true, reason: "I couldn't read the reminder list right now." };
    }

    return {
      reminders: read.reminders.map((reminder) => ({
        id: reminder.id,
        message: reminder.message,
        fireAt: formatUserDateTime(new Date(reminder.fireAt)),
      })),
    };
  },
});
