import { defineSchedule } from "eve/schedules";

import { briefingAuth, briefingMessage } from "#lib/briefing.js";
import { dailyCron } from "#lib/cron.js";
import { claimDay } from "#lib/daily-claim.js";
import { homeDelivery } from "#lib/delivery.js";
import { currentTimeContext, userLocalDate, userTimeZone } from "#lib/time.js";

export default defineSchedule({
  cron: dailyCron({ hour: 7 }, userTimeZone),
  async run({ to, waitUntil }) {
    const home = await homeDelivery();
    if (!home) {
      console.warn("[briefing] skipping; no home delivery target is stored");
      return;
    }

    const day = userLocalDate();
    if (!(await claimDay("briefing", day))) {
      console.log(`[briefing] skipping; ${day} is already claimed`);
      return;
    }

    const { channel, target, owner } = home;
    const delivery = briefingMessage(currentTimeContext())
      .then((message) =>
        channel.deliver({
          to,
          message,
          target,
          auth: briefingAuth(owner, day),
          turnPolicy: "queue",
        }),
      )
      .then(
        () => console.log(`[briefing] delivered ${day}`),
        (error) => console.error(`[briefing] failed to deliver ${day}`, error),
      );
    waitUntil(delivery);
  },
});
