import { defineSchedule } from "eve/schedules";

import { dailyCron } from "#lib/cron.js";
import { readHomeTarget } from "#lib/home-target.js";
import { watchMailboxes } from "#lib/mail-watch.js";
import { userTimeZone } from "#lib/time.js";

export default defineSchedule({
  cron: dailyCron({ hour: 6 }, userTimeZone),
  async run() {
    const home = await readHomeTarget();
    if (!home) {
      console.warn("[mail] not watching mailboxes; no home owner is stored to act as");
      return;
    }

    const outcomes = await watchMailboxes(home.owner, { force: true });
    if (!outcomes) {
      console.log("[mail] not watching mailboxes; GOOGLE_PUBSUB_TOPIC or GOOGLE_CONNECTOR is not set");
      return;
    }
    console.log(`[mail] mailbox watches: ${JSON.stringify(outcomes)}`);
    if (Object.values(outcomes).includes("failed")) throw new Error("a mailbox watch could not be renewed");
  },
});
