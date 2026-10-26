import type { SharedCache } from "#lib/shared-cache.js";

const runAfterWindowSeconds = 5;
const runCountTtlSeconds = 2 * 24 * 60 * 60;

export interface CoalescedRun<T> {
  readonly body: T;
  readonly deduplicationId: string;
  readonly delaySeconds: number;
}

// Every push for one source in one window shares a QStash deduplication id and a run just after the
// window closes, so a burst becomes one run, and runs for the same source are a window apart.
export function coalescedRun<T>(input: {
  readonly prefix: string;
  readonly source: string;
  readonly body: T;
  readonly windowMs: number;
  readonly now?: Date;
}): CoalescedRun<T> {
  const now = (input.now ?? new Date()).getTime();
  const window = Math.floor(now / input.windowMs);
  const windowEnd = (window + 1) * input.windowMs;
  return {
    body: input.body,
    deduplicationId: `${input.prefix}-${input.source.replace(/[^\w-]/gu, "_")}-${window}`,
    delaySeconds: Math.ceil((windowEnd - now) / 1000) + runAfterWindowSeconds,
  };
}

// Pushes must never spend the QStash budget reminders and coding watches rely on. Best effort: the
// count is not atomic, which can only let a few extra runs through.
export async function takeDailyRun(
  cache: SharedCache,
  input: { readonly key: string; readonly day: string; readonly cap: number; readonly label: string },
): Promise<boolean> {
  const key = `${input.key}:${input.day}`;
  const used = Number(await cache.get(key)) || 0;
  if (used >= input.cap) {
    if (used === input.cap) {
      console.warn(`[${input.label}] reached ${input.cap} runs on ${input.day}; the rest wait until tomorrow`);
      await cache.set(key, used + 1, runCountTtlSeconds);
    }
    return false;
  }
  await cache.set(key, used + 1, runCountTtlSeconds);
  return true;
}
