import { defineChannel, POST } from "eve/channels";
import type { SessionAuthContext } from "eve/context";

import { deliveryChannelByName } from "#lib/delivery.js";
import { remindersDeliverPath } from "#lib/env.js";
import { verifyReminderSignature } from "#lib/qstash.js";
import { currentTimeContext } from "#lib/time.js";

const reminderAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "qstash",
  principalId: "reminders",
  principalType: "service",
};

export default defineChannel({
  routes: [
    POST(remindersDeliverPath, async (req, { to, waitUntil }) => {
      const signature = req.headers.get("upstash-signature") ?? "";
      const body = await req.text();

      if (!(await verifyReminderSignature({ signature, body }))) {
        return new Response("invalid signature", { status: 401 });
      }

      const { message, channel, target } = JSON.parse(body) as {
        message: string;
        channel: string;
        target: Record<string, unknown>;
      };

      const delivery = deliveryChannelByName(channel);
      if (!delivery) {
        return new Response(`unknown delivery channel: ${channel}`, { status: 400 });
      }

      // Local time rides in the message body: eve's proactive receive() path
      // has no `context` field, unlike an inbound channel dispatch.
      waitUntil(
        delivery.deliver({
          to,
          message: `${currentTimeContext()}\n\nA reminder you scheduled earlier is now due: ${message}`,
          target,
          auth: reminderAuth,
        }),
      );

      return new Response("ok");
    }),
  ],
});
