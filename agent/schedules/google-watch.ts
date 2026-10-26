import { defineSchedule } from "eve/schedules";

import { dailyCron } from "#lib/cron.js";
import { anyWatchFailed, watchGoogleAccounts } from "#lib/google-watch.js";
import { readHomeTarget } from "#lib/home-target.js";
import { userTimeZone } from "#lib/time.js";

export default defineSchedule({
  cron: dailyCron({ hour: 6 }, userTimeZone),
  async run() {
    const home = await readHomeTarget();
    if (!home) {
      console.warn("[google-watch] not watching Google accounts; no home owner is stored to act as");
      return;
    }

    const watches = await watchGoogleAccounts(home.owner, { force: true });
    if (!watches.mail) console.log("[mail] not watching mailboxes; GOOGLE_PUBSUB_TOPIC or GOOGLE_CONNECTOR is not set");
    else console.log(`[mail] mailbox watches: ${JSON.stringify(watches.mail)}`);
    if (!watches.calendar) console.log("[calendar] not watching calendars; GOOGLE_CONNECTOR is not set or BASE_URL is not https");
    else console.log(`[calendar] calendar watches: ${JSON.stringify(watches.calendar)}`);
    if (anyWatchFailed(watches)) throw new Error("a Google watch could not be renewed");
  },
});
