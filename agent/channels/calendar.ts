import { defineChannel, POST } from "eve/channels";

import { calendarPushHandler, calendarRunHandler } from "#lib/calendar-routes.js";
import { calendarReader, calendarTokens } from "#lib/calendar-watch.js";
import { homeDelivery } from "#lib/delivery.js";
import { calendarProcessPath, calendarPushPath, env } from "#lib/env.js";
import { google } from "#lib/google.js";
import { hasValidCallbackSignature, publishCallback } from "#lib/qstash.js";
import { secretCache } from "#lib/shared-cache.js";
import { currentTimeContext, userLocalDate } from "#lib/time.js";

const push = calendarPushHandler({
  tokens: calendarTokens,
  cache: secretCache,
  today: () => userLocalDate(),
  publish: async (run) => {
    await publishCallback({ url: env.calendarProcessUrl, ...run });
  },
});

const processRun = calendarRunHandler({
  cache: secretCache,
  timeContext: () => currentTimeContext(),
  verify: (request, body) => hasValidCallbackSignature(request, body, env.calendarProcessUrl),
  isListed: async (owner, account) => (await google.accountNames(owner)).includes(account),
  ownerAddresses: (owner) => google.accountAddresses(owner),
  reader: calendarReader,
});

export default defineChannel({
  routes: [
    POST(calendarPushPath, (request) => push(request)),
    POST(calendarProcessPath, (request, { to }) =>
      processRun(request, async () => {
        const home = await homeDelivery();
        if (!home) return null;
        const { channel, target, owner } = home;
        return {
          owner,
          async deliver(message, auth) {
            await channel.deliver({ to, message, target, auth, turnPolicy: "queue" });
          },
        };
      }),
    ),
  ],
});
