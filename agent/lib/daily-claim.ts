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

// Vercel Cron can deliver the same run twice. A conditional write on one pointer per job lets
// exactly one of them claim the day; any failure counts as not claimed, so a run is missed
// rather than sent twice.
export async function claimDay(store: ClaimStore, job: string, day: string): Promise<DayClaim | null> {
  try {
    const current = await store.read(job);
    if (current?.day === day) return null;

    const { etag } = await store.write(job, day, current ? { etag: current.etag } : "absent");
    return { job, day, etag };
  } catch (error) {
    console.warn(`[daily-claim] could not claim ${job} for ${day}`, error);
    return null;
  }
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
