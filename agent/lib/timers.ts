import { blobDocumentStore } from "#lib/blob-document.js";
import { env } from "#lib/env.js";
import { cancelCallback, maxDelaySeconds, publishCallback } from "#lib/qstash.js";
import { createTimers, longTimersSchema } from "#lib/timer.js";

export const timers = createTimers({
  backend: { maxDelaySeconds, publish: publishCallback, cancel: cancelCallback },
  store: blobDocumentStore("long-timers.json", longTimersSchema),
  hopUrl: env.timersHopUrl,
});
