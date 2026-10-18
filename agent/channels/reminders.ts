import { defineChannel, POST } from "eve/channels";
import { z } from "zod";

import { deliveryChannelByName } from "#lib/delivery.js";
import { env, remindersDeliverPath } from "#lib/env.js";
import { readHomeTarget, type HomeTarget } from "#lib/home-target.js";
import { hasValidCallbackSignature, parseJson } from "#lib/qstash.js";
import { forgetReminder } from "#lib/reminder-list.js";
import { blobReminderListStore } from "#lib/reminder-list-store.js";
import { reminderAuth, reminderDestination } from "#lib/reminders.js";
import { currentTimeContext } from "#lib/time.js";

const reminderSchema = z.object({
  message: z.string().min(1),
  channel: z.string().min(1),
  target: z.record(z.string(), z.unknown()),
});

async function currentHome(): Promise<HomeTarget | null> {
  try {
    return await readHomeTarget();
  } catch (error) {
    console.warn("[reminders] could not read the home pointer; delivering without the owner's identity", error);
    return null;
  }
}

export default defineChannel({
  routes: [
    POST(remindersDeliverPath, async (request, { to }) => {
      const body = await request.text();
      if (!(await hasValidCallbackSignature(request, body, env.remindersDeliverUrl))) {
        return new Response("invalid signature", { status: 401 });
      }

      const parsed = reminderSchema.safeParse(parseJson(body));
      if (!parsed.success) {
        console.warn("[reminders] rejected malformed reminder");
        return new Response("invalid payload", { status: 400 });
      }

      const { message, channel, target } = parsed.data;
      const messageId = request.headers.get("upstash-message-id");
      const retried = request.headers.get("upstash-retried");
      const home = await currentHome();
      const destination = reminderDestination({ channel, target }, home);
      const delivery = deliveryChannelByName(destination.channel);
      if (!delivery) {
        return new Response(`unknown delivery channel: ${destination.channel}`, { status: 400 });
      }

      // Local time rides in the message body: eve's proactive receive() path
      // has no `context` field, unlike an inbound channel dispatch.
      try {
        await delivery.deliver({
          to,
          message: `${currentTimeContext()}\n\nA reminder you scheduled earlier is now due: ${message}`,
          target: destination.target,
          auth: reminderAuth(home?.owner ?? null, messageId),
          turnPolicy: "queue",
        });
      } catch (error) {
        console.error(`[reminders] failed to hand off ${messageId} on ${channel} (retried ${retried})`, error);
        return new Response("delivery failed", { status: 500 });
      }

      if (messageId) await forgetReminder(blobReminderListStore, messageId);

      console.log(`[reminders] handed off ${messageId} on ${channel} (retried ${retried})`);
      return new Response("ok");
    }),
  ],
});
