export interface StoredClaim {
  day: string | null;
  etag: string;
}

export interface ClaimStore {
  read(job: string): Promise<StoredClaim | null>;
  write(job: string, day: string, expected: { etag: string } | "absent"): Promise<{ etag: string }>;
  remove(job: string, etag: string): Promise<void>;
}

export interface DayClaim {
  job: string;
  day: string;
  etag: string;
}

export type ClaimAttempt =
  | { readonly status: "claimed"; readonly claim: DayClaim }
  | { readonly status: "taken" }
  | { readonly status: "unavailable"; readonly error: unknown };

async function heldAs(store: ClaimStore, job: string, day: string): Promise<boolean> {
  try {
    return (await store.read(job))?.day === day;
  } catch {
    return false;
  }
}

// A conditional write on one pointer per job lets exactly one caller win. A failed write that
// another caller's value now explains lost a race; any other failure leaves the outcome unknown,
// and each caller decides whether unknown means skip or go ahead.
export async function tryClaim(store: ClaimStore, job: string, day: string): Promise<ClaimAttempt> {
  try {
    const current = await store.read(job);
    if (current?.day === day) return { status: "taken" };

    const { etag } = await store.write(job, day, current ? { etag: current.etag } : "absent");
    return { status: "claimed", claim: { job, day, etag } };
  } catch (error) {
    return (await heldAs(store, job, day)) ? { status: "taken" } : { status: "unavailable", error };
  }
}

// Vercel Cron can deliver the same run twice, so an unknown outcome counts as not claimed: a run
// is missed rather than sent twice.
export async function claimDay(store: ClaimStore, job: string, day: string): Promise<DayClaim | null> {
  const attempt = await tryClaim(store, job, day);
  if (attempt.status === "unavailable") {
    console.warn(`[daily-claim] could not claim ${job} for ${day}`, attempt.error);
  }
  return attempt.status === "claimed" ? attempt.claim : null;
}

// A one-off event, such as a webhook that can be retried or replayed, is a claim that never rolls over.
export function claimOnce(store: ClaimStore, key: string): Promise<DayClaim | null> {
  return claimDay(store, key, "once");
}

export function tryClaimOnce(store: ClaimStore, key: string): Promise<ClaimAttempt> {
  return tryClaim(store, key, "once");
}

// The etag must still match, so this only ever undoes the caller's own claim.
export async function releaseDay(store: ClaimStore, claim: DayClaim): Promise<boolean> {
  try {
    await store.remove(claim.job, claim.etag);
    return true;
  } catch (error) {
    console.warn(`[daily-claim] could not release ${claim.job} for ${claim.day}`, error);
    return false;
  }
}
