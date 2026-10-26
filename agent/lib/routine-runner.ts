import type { RouteHandlerArgs } from "eve/channels";

import { takeDailyRun } from "#lib/coalesce.js";
import { homeDelivery } from "#lib/delivery.js";
import { armRoutineRun, blobRoutineStore } from "#lib/routine-store.js";
import {
  claimDueRoutines,
  type DueRoutine,
  maxRunsPerDay,
  releaseRoutines,
  routineAuth,
  routinesMessage,
} from "#lib/routines.js";
import { sharedCache } from "#lib/shared-cache.js";
import { currentTimeContext, formatUserDateTime, userLocalDate, userTimeZone } from "#lib/time.js";

// A backstop: the run budget in lib/routines.ts already keeps active routines within it.
const dailyRunCap = maxRunsPerDay;
const slotTtlSeconds = 2 * 24 * 60 * 60;

// A retried delivery of the same run reuses its slot, so failures cannot spend the day's cap.
async function takeRunSlot(entry: DueRoutine, day: string): Promise<boolean> {
  const slot = `routine-slot:${entry.routine.id}:${entry.at}`;
  if (await sharedCache.get(slot)) return true;
  if (!(await takeDailyRun(sharedCache, { key: "routine-runs", day, cap: dailyRunCap, label: "routines" }))) return false;
  await sharedCache.set(slot, true, slotTtlSeconds);
  return true;
}

export async function runDueRoutines(to: RouteHandlerArgs["to"], now: Date = new Date()): Promise<void> {
  const home = await homeDelivery();
  if (!home) {
    console.warn("[routines] skipping; no home delivery target is stored");
    return;
  }

  const claim = await claimDueRoutines(blobRoutineStore, { now, timeZone: userTimeZone });
  const claimed = [...claim.due, ...claim.skipped];
  try {
    for (const at of claim.arm) await armRoutineRun(at);
  } catch (error) {
    console.error("[routines] could not arm the next runs; releasing the claim for the retry", error);
    await releaseRoutines(blobRoutineStore, claimed);
    throw error;
  }
  for (const entry of claim.skipped) console.warn(`[routines] skipped ${entry.routine.id}'s run at ${entry.at}: too late`);

  const day = userLocalDate(now);
  const due: DueRoutine[] = [];
  for (const entry of claim.due) {
    if (await takeRunSlot(entry, day)) due.push(entry);
    else console.warn(`[routines] dropped ${entry.routine.id}'s run at ${entry.at}: over today's cap of ${dailyRunCap}`);
  }
  if (!due.length) return;

  const ids = due.map((entry) => entry.routine.id).join(", ");
  try {
    await home.channel.deliver({
      to,
      message: routinesMessage(currentTimeContext(now), due, formatUserDateTime),
      target: home.target,
      auth: routineAuth(home.owner, due[0].at),
      turnPolicy: "queue",
    });
    console.log(`[routines] delivered ${ids}`);
  } catch (error) {
    console.error(`[routines] failed to deliver ${ids}; releasing them for the retry`, error);
    await releaseRoutines(blobRoutineStore, due);
    throw error;
  }
}
