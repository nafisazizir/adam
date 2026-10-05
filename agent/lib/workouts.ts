import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

import { env } from "#lib/env.js";
import type { HomeOwner } from "#lib/home-target.js";
import { ownerAuth } from "#lib/owner.js";
import { currentTimeContext } from "#lib/time.js";

export type WorkoutSource = "strava" | "hevy";

export interface WorkoutRef {
  readonly source: WorkoutSource;
  readonly id: string;
}

export const workoutRefSchema = z.object({
  source: z.enum(["strava", "hevy"]),
  id: z.string().min(1),
});

export const workoutAuthenticator = "workouts";

// Hevy owns strength, so Strava's WeightTraining mirror would analyse the same session twice.
export const skippedStravaSportTypes: ReadonlySet<string> = new Set(["WeightTraining", "Walk"]);

export const alreadyAnalysedMarker = "ALREADY_ANALYSED";

export const silentReplyMarker = "<eve-empty-delivery/>";

function workoutLabel(ref: WorkoutRef): string {
  return ref.source === "strava" ? `Strava activity ${ref.id}` : `Hevy workout ${ref.id}`;
}

export function coachRequest(ref: WorkoutRef, options: { dryRun?: boolean } = {}): string {
  return [
    `Run the workout debrief for ${workoutLabel(ref)}, which the user just finished.`,
    `Training plan data source: ${env.NOTION_PLANS_DATA_SOURCE_ID}`,
    `Workouts data source: ${env.NOTION_WORKOUTS_DATA_SOURCE_ID}`,
    options.dryRun
      ? "This is a dry run: write nothing to Notion."
      : "This is a live run: write the page to Notion.",
  ].join("\n");
}

export function analysisMessage(ref: WorkoutRef): string {
  return [
    currentTimeContext(),
    "",
    "<workout_trigger>",
    `The user just finished a workout (${workoutLabel(ref)}). This is an automated run that nobody reads; it is not a conversation.`,
    "Call the `coach` subagent once, with exactly this message:",
    "",
    coachRequest(ref),
    "",
    "Then reply with the debrief the coach returns, exactly as it came back. No edits, no commentary, nothing added.",
    "</workout_trigger>",
  ].join("\n");
}

export function debriefMessage(debrief: string): string {
  return [
    currentTimeContext(),
    "",
    "<workout_debrief>",
    "The user just finished a workout. The coach has analysed it and saved the full write-up in their Notion. This is the coach's debrief:",
    "",
    debrief.trim(),
    "</workout_debrief>",
    "",
    `Follow your workout rules: text them only if this clears the bar, otherwise reply with exactly ${silentReplyMarker}.`,
  ].join("\n");
}

export function workoutAddress(ref: WorkoutRef): string {
  return `${ref.source}:${ref.id}`;
}

export function workoutAuth(ref: WorkoutRef, owner: HomeOwner): SessionAuthContext {
  return ownerAuth(owner, {
    attributes: { source: ref.source, id: ref.id },
    authenticator: workoutAuthenticator,
  });
}
