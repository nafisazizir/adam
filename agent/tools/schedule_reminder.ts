import { defineTool } from "eve/tools";
import { z } from "zod";

import { deliveryChannelForAuth } from "#lib/delivery.js";
import { publishReminder } from "#lib/qstash.js";
import { scheduledReminders } from "#lib/reminders.js";

export default defineTool({
  description:
    "Schedule a one-time reminder to be delivered to the user after a delay. " +
    "delaySeconds is how many seconds from now it should fire: convert the user's " +
    "phrasing yourself (e.g. 'in 15 minutes' is 900, 'in 2 hours' is 7200). " +
    "message is the reminder text in your own voice. Use for relative timing only.",
  inputSchema: z.object({
    message: z
      .string()
      .min(1)
      .describe("What to remind the user about, phrased in your own voice."),
    delaySeconds: z
      .number()
      .int()
      .positive()
      .describe("Seconds from now until the reminder fires."),
  }),
  async execute({ message, delaySeconds }, ctx) {
    const auth = ctx.session.auth.initiator ?? ctx.session.auth.current;
    const resolved = auth ? deliveryChannelForAuth(auth) : null;

    if (!resolved) {
      throw new Error(
        "This session has no channel I can deliver a reminder back to.",
      );
    }

    const id = await publishReminder({
      message,
      channel: resolved.channel.name,
      target: resolved.target,
      delaySeconds,
    });
    const fireAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    scheduledReminders.update((list) => [...list, { id, message, fireAt }]);

    return { id, message, fireAt };
  },
});
