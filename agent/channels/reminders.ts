import { defineChannel, POST } from "eve/channels";
import type { SessionAuthContext } from "eve/context";

import { deliveryChannelByName } from "#lib/delivery.js";
import { verifyReminderSignature } from "#lib/qstash.js";

const reminderAuth: SessionAuthContext = {
  attributes: {},
  authenticator: "qstash",
  principalId: "reminders",
  principalType: "service",
};

export default defineChannel({
  routes: [
    POST("/deliver", async (req, { receive, waitUntil }) => {
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

      waitUntil(
        delivery.deliver({
          receive,
          message: `A reminder you scheduled earlier is now due: ${message}`,
          target,
          auth: reminderAuth,
        }),
      );

      return new Response("ok");
    }),
  ],
});
