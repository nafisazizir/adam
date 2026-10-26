import type { RouteHandlerArgs } from "eve/channels";

import { takeDailyRun } from "#lib/coalesce.js";
import { homeDelivery } from "#lib/delivery.js";
import { armRoutineRun, blobRoutineStore } from "#lib/routine-store.js";
import { claimDueRoutines, releaseRoutines, routineAuth, routinesMessage } from "#lib/routines.js";
import { sharedCache } from "#lib/shared-cache.js";
import { currentTimeContext, formatUserDateTime, userLocalDate, userTimeZone } from "#lib/time.js";

// Routine turns must never spend the QStash budget reminders rely on.
const dailyRunCap = 48;

async function armAll(instants: readonly string[]): Promise<void> {
  for (const at of instants) {
    try {
      await armRoutineRun(at);
    } catch (error) {
      console.error(`[routines] could not arm the run at ${at}; the daily sweep will skip it and re-arm`, error);
    }
  }
}

export async function runDueRoutines(to: RouteHandlerArgs["to"], now: Date = new Date()): Promise<void> {
  const home = await homeDelivery();
  if (!home) {
    console.warn("[routines] skipping; no home delivery target is stored");
    return;
  }

  const clock = { now, timeZone: userTimeZone };
  const claim = await claimDueRoutines(blobRoutineStore, clock);
  await armAll(claim.arm);
  for (const entry of claim.skipped) console.warn(`[routines] skipped ${entry.routine.id}'s run at ${entry.at}: too late`);
  if (!claim.due.length) return;

  const day = userLocalDate(now);
  if (!(await takeDailyRun(sharedCache, { key: "routine-runs", day, cap: dailyRunCap, label: "routines" }))) return;

  const ids = claim.due.map((entry) => entry.routine.id).join(", ");
  try {
    await home.channel.deliver({
      to,
      message: routinesMessage(currentTimeContext(now), claim.due, formatUserDateTime),
      target: home.target,
      auth: routineAuth(home.owner, claim.due[0].at),
      turnPolicy: "queue",
    });
    console.log(`[routines] delivered ${ids}`);
  } catch (error) {
    console.error(`[routines] failed to deliver ${ids}; releasing them for the retry`, error);
    await releaseRoutines(blobRoutineStore, claim.due);
    throw error;
  }
}
