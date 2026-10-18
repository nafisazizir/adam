import { defineTool } from "eve/tools";
import { z } from "zod";

import { deliveryChannelForAuth, homeDelivery } from "#lib/delivery.js";
import { publishReminder } from "#lib/qstash.js";
import { replayStableKey } from "#lib/replay-key.js";
import { recordReminder } from "#lib/reminder-list.js";
import { blobReminderListStore } from "#lib/reminder-list-store.js";
import { reminderTiming } from "#lib/reminder-timing.js";
import { formatUserDateTime, userLocalDateTimeToInstant } from "#lib/time.js";

export default defineTool({
  description:
    "Schedule a one-time reminder to be delivered to the user. Give exactly one of " +
    "delaySeconds or at, and omit the other. delaySeconds is for relative phrasing ('in 15 minutes' is 900, " +
    "'in 2 hours' is 7200). at is for any clock time ('tomorrow at 7am'): a local " +
    "wall-clock date-time like 2026-10-03T07:00 in the user's time zone, read from the " +
    "current local date and time in context. Never convert a clock time into seconds " +
    "yourself. leadMinutes (only with at) fires that many minutes before at. A reminder " +
    "with leadMinutes that would fire in the past or within 5 minutes returns " +
    "{ skipped: 'too soon' } instead of being scheduled; a plain at in the past is an error. message is the reminder text in your own voice.",
  inputSchema: z.object({
    message: z
      .string()
      .min(1)
      .describe("What to remind the user about, phrased in your own voice."),
    delaySeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Seconds from now until the reminder fires. For relative times; omit when using at."),
    at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .optional()
      .describe("Local date-time YYYY-MM-DDTHH:mm in the user's time zone. For clock times; omit delaySeconds."),
    leadMinutes: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("With at: fire this many minutes before at. Default 0."),
  }),
  async execute({ message, delaySeconds: relativeDelay, at, leadMinutes = 0 }, ctx) {
    if ((relativeDelay === undefined) === (at === undefined)) {
      throw new Error("Give exactly one of delaySeconds or at.");
    }
    if (relativeDelay !== undefined && leadMinutes > 0) {
      throw new Error("leadMinutes only works together with at.");
    }
    const now = Date.now();
    const timing = reminderTiming(
      relativeDelay !== undefined
        ? { delaySeconds: relativeDelay }
        : { targetMs: userLocalDateTimeToInstant(at!).getTime(), leadMinutes },
      now,
    );
    if (timing.kind === "past") {
      throw new Error(
        `${at} is already in the past (it is now ${formatUserDateTime(new Date(now))}); pick a future time.`,
      );
    }
    if (timing.kind === "skipped") return { skipped: "too soon" };
    const { delaySeconds, fireAtMs } = timing;

    const { current, initiator } = ctx.session.auth;
    const resolved =
      (current && deliveryChannelForAuth(current)) ??
      (initiator && deliveryChannelForAuth(initiator)) ??
      (await homeDelivery());

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
      idempotencyKey: replayStableKey(ctx, message, at ?? relativeDelay!, leadMinutes),
    });
    const fireAt = new Date(fireAtMs);
    await recordReminder(blobReminderListStore, { id, message, fireAt: fireAt.toISOString() });

    return { id, message, fireAt: formatUserDateTime(fireAt) };
  },
});
