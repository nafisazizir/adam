import type { SessionAuthContext } from "eve/context";

import { outboundCallBriefing, ownerPhoneNumber } from "#lib/calls.js";
import { claimOnce, type ClaimStore, releaseDay } from "#lib/daily-claim.js";
import { isOwnerChat } from "#lib/delivery.js";
import { env } from "#lib/env.js";
import type { KnownOwner } from "#lib/owner.js";
import { claimRateSlot, type RateLimit, releaseRateSlot } from "#lib/rate-limit.js";
import { isRingingReminderTurn } from "#lib/reminders.js";
import { formatUserDateTime } from "#lib/time.js";
import { CallNotPlaced, type OutboundCall, type OutboundLine, type PlacedCall } from "#lib/voice.js";

const budgetJob = "outbound-calls";

// Enough for a wake-up call, a snooze and a few "call me"s a day; a loop stops at the first gap.
export const ringLimit: RateLimit = { minGapMs: 10 * 60 * 1000, max: 6, windowMs: 24 * 60 * 60 * 1000 };

// Ringing interrupts, and a turn started by mail, an invite, a coding agent or a call carries text
// someone else wrote, so only the owner's say-so can ring: their chat, or a reminder they asked to
// be rung for from chat.
export function ringOwnerRefusal(auth: SessionAuthContext | null | undefined): string | null {
  if (isOwnerChat(auth) || isRingingReminderTurn(auth)) return null;
  return "Only the user can have you ring them: from chat, or with a reminder they asked you to ring them for. Text them instead.";
}

export interface RingOwnerDeps {
  readonly line: OutboundLine | null;
  readonly owner: () => Promise<KnownOwner>;
  readonly budget: ClaimStore;
  readonly place: (line: OutboundLine, call: OutboundCall) => Promise<PlacedCall>;
  readonly now?: () => number;
}

export type RingOutcome =
  | { readonly rung: true; readonly conversationId: string | null }
  | { readonly rung: false; readonly error: string; readonly uncertain?: true };

const notConfigured =
  "Calling out isn't set up: it needs ELEVENLABS_API_KEY, CALLS_PHONE_NUMBER and CALLS_TOOL_SECRET. Text them instead.";

export function outboundLine(settings: {
  readonly apiKey?: string;
  readonly fromNumber?: string;
  readonly toolSecret?: string;
}): OutboundLine | null {
  const { apiKey, fromNumber, toolSecret } = settings;
  // Without the tool secret the ask route refuses, so the voice agent could say nothing from Adam.
  return apiKey && fromNumber && toolSecret ? { apiKey, fromNumber } : null;
}

export function configuredOutboundLine(): OutboundLine | null {
  return outboundLine({
    apiKey: env.ELEVENLABS_API_KEY,
    fromNumber: env.CALLS_PHONE_NUMBER,
    toolSecret: env.CALLS_TOOL_SECRET,
  });
}

export const noOwnerNumber =
  "None of the user's iMessage handles is a phone number, so there is nothing to ring. Say that adding their " +
  "phone number in E.164 to OWNER_IMESSAGE_HANDLES, next to their email, lets you call.";

// QStash can redeliver a reminder after the gap has passed, so each ringing reminder rings once.
export function ringOnceKey(auth: SessionAuthContext | null | undefined): string | undefined {
  const messageId = auth?.attributes["message_id"];
  if (!isRingingReminderTurn(auth) || typeof messageId !== "string" || !messageId) return undefined;
  return `ring-${messageId.replace(/[^\w-]/gu, "_")}`;
}

// `once` names a claim this ring takes, so the same trigger can't ring twice; it is given back
// whenever the phone certainly did not ring.
export async function ringOwner(reason: string, deps: RingOwnerDeps, once?: string): Promise<RingOutcome> {
  if (once === undefined) return ringWithinBudget(reason, deps);

  const claim = await claimOnce(deps.budget, once);
  if (!claim) {
    return {
      rung: false,
      error: "This reminder already rang them, or that could not be checked, so no call went out. Text them instead.",
    };
  }
  const outcome = await ringWithinBudget(reason, deps);
  if (!outcome.rung && !outcome.uncertain) await releaseDay(deps.budget, claim);
  return outcome;
}

async function ringWithinBudget(reason: string, deps: RingOwnerDeps): Promise<RingOutcome> {
  if (!deps.line) return { rung: false, error: notConfigured };

  const toNumber = ownerPhoneNumber(await deps.owner());
  if (!toNumber) return { rung: false, error: `${noOwnerNumber} Text them instead.` };

  const now = deps.now?.() ?? Date.now();
  const claim = await claimRateSlot(deps.budget, budgetJob, now, ringLimit);
  if (!claim.claimed) {
    if (claim.reason === "unavailable") console.warn("[ring-owner] could not read the call budget", claim.error);
    return {
      rung: false,
      error:
        claim.reason === "limited"
          ? `You already rang them recently; the next call can go out at ${formatUserDateTime(new Date(claim.retryAt))}. Text them instead.`
          : "Could not check how often you have rung them, so no call went out. Text them instead.",
    };
  }

  try {
    const briefing = outboundCallBriefing(formatUserDateTime(new Date(now)), reason);
    const placed = await deps.place(deps.line, { toNumber, briefing });
    console.log(`[ring-owner] ringing the owner, conversation ${placed.conversationId ?? "unknown"}`);
    return { rung: true, conversationId: placed.conversationId };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof CallNotPlaced) {
      console.error("[ring-owner] the call did not go out", error);
      await releaseRateSlot(deps.budget, claim.slot);
      return { rung: false, error: `The call did not go out (${detail}). Text them instead.` };
    }
    // The slot stays claimed, so a retry can't ring them a second time.
    console.error("[ring-owner] the call may have gone out", error);
    return {
      rung: false,
      uncertain: true,
      error: `The call may have gone out (${detail}). Do not ring again; text them the reason in case it didn't.`,
    };
  }
}
