import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryDocumentStore } from "#lib/json-document.js";
import { createTimers, type Hop, type LongTimers, type TimerBackend } from "#lib/timer.js";

const daySeconds = 24 * 60 * 60;
const dayMs = daySeconds * 1000;

interface Published {
  id: string;
  url: string;
  body: unknown;
  delaySeconds: number;
  deduplicationId: string;
}

function harness() {
  let clock = Date.parse("2026-10-26T00:00:00Z");
  const published: Published[] = [];
  const cancelled: string[] = [];
  const deduplicated = new Map<string, { id: string; at: number }>();
  // Like QStash: a repeated deduplication id within ten minutes returns the first message's id.
  const backend: TimerBackend = {
    maxDelaySeconds: 7 * daySeconds,
    async publish(input) {
      await Promise.resolve();
      const seen = deduplicated.get(input.deduplicationId);
      if (seen && clock - seen.at < 10 * 60_000) return seen.id;
      const id = `msg_${published.length + 1}`;
      published.push({ id, ...input });
      deduplicated.set(input.deduplicationId, { id, at: clock });
      return id;
    },
    async cancel(id) {
      cancelled.push(id);
      return "cancelled";
    },
  };
  const store = memoryDocumentStore<LongTimers>();
  const timers = createTimers({ backend, store, hopUrl: "https://adam.test/hop", now: () => clock });
  return {
    timers,
    store,
    published,
    cancelled,
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
  };
}

test("a timer within the horizon goes straight to its destination", async () => {
  const h = harness();
  const id = await h.timers.set({ url: "https://adam.test/deliver", body: { a: 1 }, fireAtMs: h.now() + 90_000, key: "k:1" });
  assert.equal(id, "msg_1");
  assert.deepEqual(h.published, [
    { id: "msg_1", url: "https://adam.test/deliver", body: { a: 1 }, delaySeconds: 90, deduplicationId: "k_1" },
  ]);
  assert.equal(h.store.value, undefined);
});

test("a timer beyond the horizon hops until its last leg lands on the destination", async () => {
  const h = harness();
  const fireAtMs = h.now() + 20 * dayMs;
  const id = await h.timers.set({ url: "https://adam.test/deliver", body: { a: 1 }, fireAtMs, key: "k" });
  assert.match(id, /^timer_[0-9a-f]{24}$/u);
  assert.equal(h.published[0].url, "https://adam.test/hop");
  assert.deepEqual(h.store.value?.timers, [{ id, fireAt: new Date(fireAtMs).toISOString(), messageId: "msg_1" }]);

  for (let leg = 0; leg < 5 && h.published.at(-1)!.url === "https://adam.test/hop"; leg += 1) {
    const last = h.published.at(-1)!;
    assert.ok(last.delaySeconds <= 7 * daySeconds);
    h.advance(last.delaySeconds * 1000);
    assert.equal(await h.timers.hop(last.body as Hop, last.id), "forwarded");
  }
  const final = h.published.at(-1)!;
  assert.equal(final.url, "https://adam.test/deliver");
  assert.deepEqual(final.body, { a: 1 });
  assert.equal(h.now() + final.delaySeconds * 1000, fireAtMs);
  assert.equal(h.store.value?.timers[0].messageId, final.id);
});

test("a duplicate hop delivery is stale and publishes nothing", async () => {
  const h = harness();
  await h.timers.set({ url: "https://adam.test/deliver", body: {}, fireAtMs: h.now() + 20 * dayMs, key: "k" });
  const first = h.published[0];
  h.advance(first.delaySeconds * 1000);
  assert.equal(await h.timers.hop(first.body as Hop, first.id), "forwarded");
  const count = h.published.length;
  assert.equal(await h.timers.hop(first.body as Hop, first.id), "stale");
  assert.equal(h.published.length, count);
});

test("cancelling a long timer cancels its live leg and stops later hops", async () => {
  const h = harness();
  const id = await h.timers.set({ url: "https://adam.test/deliver", body: {}, fireAtMs: h.now() + 20 * dayMs, key: "k" });
  assert.equal(await h.timers.cancel(id), "cancelled");
  assert.deepEqual(h.cancelled, ["msg_1"]);
  assert.deepEqual(h.store.value?.timers, []);
  assert.equal(await h.timers.hop(h.published[0].body as Hop, "msg_1"), "stale");
  assert.equal(await h.timers.cancel(id), "gone");
});

test("a long timer whose last leg has fired cancels as gone", async () => {
  const h = harness();
  const id = await h.timers.set({ url: "https://adam.test/deliver", body: {}, fireAtMs: h.now() + 10 * dayMs, key: "k" });
  h.advance(11 * dayMs);
  assert.equal(await h.timers.cancel(id), "gone");
  assert.deepEqual(h.cancelled, []);
});

test("a short timer cancels through the backend", async () => {
  const h = harness();
  assert.equal(await h.timers.cancel("msg_9"), "cancelled");
  assert.deepEqual(h.cancelled, ["msg_9"]);
});

test("a hop whose record was never written lands stale and fires nothing", async () => {
  const h = harness();
  const write = h.store.write;
  h.store.write = async () => {
    throw new Error("blob down");
  };
  await assert.rejects(
    h.timers.set({ url: "https://adam.test/deliver", body: {}, fireAtMs: h.now() + 20 * dayMs, key: "k" }),
    /blob down/u,
  );
  h.store.write = write;
  h.advance(h.published[0].delaySeconds * 1000);
  assert.equal(await h.timers.hop(h.published[0].body as Hop, "msg_1"), "stale");
  assert.equal(h.published.length, 1);
});

test("two copies of a hop landing together leave the deduplicated final leg live", async () => {
  const h = harness();
  await h.timers.set({ url: "https://adam.test/deliver", body: {}, fireAtMs: h.now() + 10 * dayMs, key: "k" });
  const first = h.published[0];
  h.advance(first.delaySeconds * 1000);
  const outcomes = await Promise.all([
    h.timers.hop(first.body as Hop, first.id),
    h.timers.hop(first.body as Hop, first.id),
  ]);
  assert.deepEqual(outcomes.sort(), ["forwarded", "stale"]);
  assert.equal(h.published.length, 2);
  assert.equal(h.published[1].url, "https://adam.test/deliver");
  assert.deepEqual(h.cancelled, []);
  assert.equal(h.store.value?.timers[0].messageId, h.published[1].id);
});

test("setting the same long timer again keeps one live chain under one id", async () => {
  const h = harness();
  const request = { url: "https://adam.test/deliver", body: {}, fireAtMs: h.now() + 20 * dayMs, key: "k" };
  const first = await h.timers.set(request);
  h.advance(5_000);
  assert.equal(await h.timers.set(request), first);
  assert.equal(h.published.length, 1);
  assert.deepEqual(h.store.value?.timers.map((timer) => timer.messageId), ["msg_1"]);

  h.advance(20 * 60_000);
  assert.equal(await h.timers.set(request), first);
  assert.deepEqual(h.store.value?.timers.map((timer) => timer.messageId), ["msg_2"]);
  assert.equal(await h.timers.hop(h.published[0].body as Hop, "msg_1"), "stale");
});
