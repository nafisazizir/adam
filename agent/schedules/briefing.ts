import { defineSchedule } from "eve/schedules";

import { briefingAuth, briefingMessage } from "#lib/briefing.js";
import { blobClaimStore } from "#lib/claim-store.js";
import { dailyCron } from "#lib/cron.js";
import { claimDay, releaseDay } from "#lib/daily-claim.js";
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
    const claim = await claimDay(blobClaimStore, "briefing", day);
    if (!claim) {
      console.log(`[briefing] skipping; ${day} is already claimed`);
      return;
    }

    const { channel, target, owner } = home;
    const delivery = (async () => {
      try {
        await channel.deliver({
          to,
          message: await briefingMessage(currentTimeContext()),
          target,
          auth: briefingAuth(owner, day),
          turnPolicy: "queue",
        });
        console.log(`[briefing] delivered ${day}`);
      } catch (error) {
        console.error(`[briefing] failed to deliver ${day}; releasing the claim`, error);
        await releaseDay(blobClaimStore, claim);
        throw error;
      }
    })();
    waitUntil(delivery);
    // Awaited too, so a failed delivery fails the cron run instead of reporting success.
    await delivery;
  },
});
