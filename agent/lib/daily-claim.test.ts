import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { claimDay, claimOnce, releaseDay, type ClaimStore } from "#lib/daily-claim.js";

class PreconditionFailed extends Error {}

function memoryStore(): ClaimStore & { raw: Map<string, { text: string; etag: string }> } {
  const raw = new Map<string, { text: string; etag: string }>();
  let version = 0;
  return {
    raw,
    async read(job) {
      const entry = raw.get(job);
      if (!entry) return null;
      let day: string | null = null;
      try {
        day = JSON.parse(entry.text).day ?? null;
      } catch {}
      return { day, etag: entry.etag };
    },
    async write(job, day, expected) {
      const entry = raw.get(job);
      if (expected === "absent" ? entry : entry?.etag !== expected.etag) throw new PreconditionFailed();
      const etag = `v${++version}`;
      raw.set(job, { text: JSON.stringify({ day }), etag });
      return { etag };
    },
    async remove(job, etag) {
      if (raw.get(job)?.etag !== etag) throw new PreconditionFailed();
      raw.delete(job);
    },
  };
}

mock.method(console, "warn", () => {});

let store: ReturnType<typeof memoryStore>;

beforeEach(() => {
  store = memoryStore();
});

test("claims a day once", async () => {
  assert.ok(await claimDay(store, "briefing", "2026-10-18"));
  assert.equal(await claimDay(store, "briefing", "2026-10-18"), null);
  assert.ok(await claimDay(store, "briefing", "2026-10-19"));
  assert.equal(await claimDay(store, "briefing", "2026-10-19"), null);
});

test("only one of two concurrent runs claims the day", async () => {
  await claimDay(store, "briefing", "2026-10-17");
  const claims = await Promise.all([
    claimDay(store, "briefing", "2026-10-18"),
    claimDay(store, "briefing", "2026-10-18"),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test("an unreadable pointer is overwritten", async () => {
  store.raw.set("briefing", { text: "not json", etag: "junk" });
  assert.ok(await claimDay(store, "briefing", "2026-10-18"));
});

test("a store failure counts as not claimed", async () => {
  store.read = async () => {
    throw new Error("blob down");
  };
  assert.equal(await claimDay(store, "briefing", "2026-10-18"), null);
});

test("a released day can be claimed again", async () => {
  const claim = await claimDay(store, "briefing", "2026-10-18");
  assert.ok(claim);
  assert.equal(await releaseDay(store, claim), true);
  assert.ok(await claimDay(store, "briefing", "2026-10-18"));
});

test("releasing a claim that was superseded leaves the newer one alone", async () => {
  const stale = await claimDay(store, "briefing", "2026-10-18");
  assert.ok(stale);
  const newer = await claimDay(store, "briefing", "2026-10-19");
  assert.ok(newer);
  assert.equal(await releaseDay(store, stale), false);
  assert.equal(await claimDay(store, "briefing", "2026-10-19"), null);
});

test("a one-off claim is won once, and released it can be won again", async () => {
  const first = await claimOnce(store, "call-ended-conv_1");
  assert.ok(first);
  assert.equal(await claimOnce(store, "call-ended-conv_1"), null);
  assert.ok(await claimOnce(store, "call-ended-conv_2"));

  assert.ok(await releaseDay(store, first));
  assert.ok(await claimOnce(store, "call-ended-conv_1"));
});
