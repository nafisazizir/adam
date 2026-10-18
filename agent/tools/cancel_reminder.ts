import { defineTool } from "eve/tools";
import { z } from "zod";

import { isCallTurn, notFromOwnerChat } from "#lib/calls.js";
import { cancelReminder } from "#lib/qstash.js";
import { forgetReminder } from "#lib/reminder-list.js";
import { blobReminderListStore } from "#lib/reminder-list-store.js";

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
  async execute({ id }, ctx) {
    if (isCallTurn(ctx.session.auth.current)) return { id, cancelled: false, reason: notFromOwnerChat };
    const outcome = await cancelReminder(id);
    await forgetReminder(blobReminderListStore, id);

    if (outcome === "gone") {
      return {
        id,
        cancelled: false,
        reason: "That reminder has already fired or was cancelled, so there is nothing left to cancel.",
      };
    }
    return { id, cancelled: true };
  },
});
