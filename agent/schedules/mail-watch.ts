import { defineSchedule } from "eve/schedules";

import { dailyCron } from "#lib/cron.js";
import { env } from "#lib/env.js";
import { google } from "#lib/google.js";
import { readHomeTarget } from "#lib/home-target.js";
import { blobMailboxStateStore } from "#lib/mailbox-state-store.js";
import { renewMailboxWatches } from "#lib/new-mail.js";
import { userTimeZone } from "#lib/time.js";

export default defineSchedule({
  cron: dailyCron({ hour: 6 }, userTimeZone),
  async run() {
    const topic = env.GOOGLE_PUBSUB_TOPIC;
    if (!topic || !google.configured) {
      console.log("[mail] not watching mailboxes; GOOGLE_PUBSUB_TOPIC or GOOGLE_CONNECTOR is not set");
      return;
    }

    const home = await readHomeTarget();
    if (!home) {
      console.warn("[mail] not watching mailboxes; no home owner is stored to act as");
      return;
    }

    const outcomes = await renewMailboxWatches(await google.accountNames(home.owner), {
      store: blobMailboxStateStore,
      watch: (account) => google.watchMailbox(home.owner, account, topic),
    });
    console.log(`[mail] mailbox watches: ${JSON.stringify(outcomes)}`);
    if (Object.values(outcomes).includes("failed")) throw new Error("a mailbox watch could not be renewed");
  },
});
