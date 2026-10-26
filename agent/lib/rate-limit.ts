import type { ClaimStore } from "#lib/daily-claim.js";

export interface RateLimit {
  readonly minGapMs: number;
  readonly max: number;
  readonly windowMs: number;
}

export type RateDecision =
  | { readonly allowed: true; readonly times: readonly number[] }
  | { readonly allowed: false; readonly retryAt: number };

// `times` are earlier claims; on success the result is what to store, this claim included.
export function rateDecision(times: readonly number[], now: number, limit: RateLimit): RateDecision {
  const recent = times.filter((time) => time > now - limit.windowMs && time <= now).sort((a, b) => a - b);
  const last = recent.at(-1);
  if (last !== undefined && now - last < limit.minGapMs) return { allowed: false, retryAt: last + limit.minGapMs };
  if (recent.length >= limit.max) return { allowed: false, retryAt: recent[recent.length - limit.max]! + limit.windowMs };
  return { allowed: true, times: [...recent, now] };
}

export function encodeTimes(times: readonly number[]): string {
  return times.join(",");
}

export function decodeTimes(value: string | null): number[] {
  return (value ?? "").split(",").map(Number).filter((time) => Number.isSafeInteger(time) && time > 0);
}

export interface RateSlot {
  readonly job: string;
  readonly previous: string;
  readonly etag: string;
}

export type RateClaim =
  | { readonly claimed: true; readonly slot: RateSlot }
  | { readonly claimed: false; readonly reason: "limited"; readonly retryAt: number }
  | { readonly claimed: false; readonly reason: "unavailable"; readonly error: unknown };

// A claim store's one conditional string per job carries the recent claim times. Anything that goes
// wrong, a lost race included, counts as not claimed: a refused action beats one repeated.
export async function claimRateSlot(store: ClaimStore, job: string, now: number, limit: RateLimit): Promise<RateClaim> {
  try {
    const current = await store.read(job);
    const previous = current?.day ?? "";
    const decision = rateDecision(decodeTimes(previous), now, limit);
    if (!decision.allowed) return { claimed: false, reason: "limited", retryAt: decision.retryAt };

    const { etag } = await store.write(job, encodeTimes(decision.times), current ? { etag: current.etag } : "absent");
    return { claimed: true, slot: { job, previous, etag } };
  } catch (error) {
    return { claimed: false, reason: "unavailable", error };
  }
}

// Only undoes the caller's own claim, since the etag must still match.
export async function releaseRateSlot(store: ClaimStore, slot: RateSlot): Promise<boolean> {
  try {
    await store.write(slot.job, slot.previous, { etag: slot.etag });
    return true;
  } catch (error) {
    console.warn(`[rate-limit] could not release a slot of ${slot.job}`, error);
    return false;
  }
}
