import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClaimStore, StoredClaim } from "#lib/daily-claim.js";
import { claimRateSlot, decodeTimes, rateDecision, releaseRateSlot } from "#lib/rate-limit.js";

const minute = 60 * 1000;
const limit = { minGapMs: 10 * minute, max: 3, windowMs: 24 * 60 * minute };
const now = Date.UTC(2026, 9, 26, 9, 0, 0);

test("allows the first claim and keeps only the window's claims", () => {
  assert.deepEqual(rateDecision([], now, limit), { allowed: true, times: [now] });
  const old = now - 25 * 60 * minute;
  assert.deepEqual(rateDecision([old, now - 30 * minute], now, limit), { allowed: true, times: [now - 30 * minute, now] });
});

test("refuses a claim inside the gap, and says when the next one may go", () => {
  assert.deepEqual(rateDecision([now - 4 * minute], now, limit), { allowed: false, retryAt: now + 6 * minute });
});

test("refuses once the window is full, until its oldest claim ages out", () => {
  const times = [now - 3 * 60 * minute, now - 2 * 60 * minute, now - 60 * minute];
  assert.deepEqual(rateDecision(times, now, limit), { allowed: false, retryAt: now + 21 * 60 * minute });
});

test("stored times survive junk", () => {
  assert.deepEqual(decodeTimes("1,abc,,2"), [1, 2]);
  assert.deepEqual(decodeTimes(null), []);
  assert.deepEqual(decodeTimes(""), []);
});

function memoryStore(initial: string | null = null) {
  let stored: StoredClaim | null = initial === null ? null : { day: initial, etag: "e0" };
  let version = 0;
  const store: ClaimStore = {
    async read() {
      return stored;
    },
    async write(_job, day, expected) {
      const matches = expected === "absent" ? stored === null : stored?.etag === expected.etag;
      if (!matches) throw new Error("conflict");
      version += 1;
      stored = { day, etag: `e${version}` };
      return { etag: stored.etag };
    },
    async remove() {
      stored = null;
    },
  };
  return { store, value: () => stored?.day ?? null };
}

test("a claim is stored, a second one inside the gap is refused, and a release undoes the first", async () => {
  const memory = memoryStore();
  const first = await claimRateSlot(memory.store, "job", now, limit);
  assert.ok(first.claimed);
  assert.equal(memory.value(), String(now));

  const second = await claimRateSlot(memory.store, "job", now + minute, limit);
  assert.deepEqual(second, { claimed: false, reason: "limited", retryAt: now + 10 * minute });

  assert.ok(await releaseRateSlot(memory.store, first.slot));
  assert.equal(memory.value(), "");
  assert.ok((await claimRateSlot(memory.store, "job", now + minute, limit)).claimed);
});

test("a store that fails or loses the race counts as not claimed", async () => {
  const broken: ClaimStore = {
    read: async () => {
      throw new Error("blob down");
    },
    write: async () => ({ etag: "x" }),
    remove: async () => {},
  };
  const result = await claimRateSlot(broken, "job", now, limit);
  assert.equal(result.claimed, false);
  assert.equal(!result.claimed && result.reason, "unavailable");

  const racing = memoryStore(String(now - 60 * minute));
  const read = racing.store.read;
  racing.store.read = async (job) => ({ ...(await read(job))!, etag: "stale" });
  assert.equal((await claimRateSlot(racing.store, "job", now, limit)).claimed, false);
});
