import assert from "node:assert/strict";
import { test } from "node:test";
import { replayStableKey } from "#lib/replay-key.js";

const ctx = { session: { id: "s1", turn: { id: "t1" } } };

test("the same inputs in the same turn give the same key", () => {
  assert.equal(replayStableKey(ctx, "take meds", 900), replayStableKey({ ...ctx }, "take meds", 900));
});

test("different inputs, turns or sessions give different keys", () => {
  const key = replayStableKey(ctx, "take meds", 900);
  assert.notEqual(key, replayStableKey(ctx, "take meds", 901));
  assert.notEqual(key, replayStableKey(ctx, "take meds", "900"));
  assert.notEqual(key, replayStableKey({ session: { id: "s1", turn: { id: "t2" } } }, "take meds", 900));
  assert.notEqual(key, replayStableKey({ session: { id: "s2", turn: { id: "t1" } } }, "take meds", 900));
});

test("input boundaries cannot be shifted to collide", () => {
  assert.notEqual(replayStableKey(ctx, "a", "bc"), replayStableKey(ctx, "ab", "c"));
});
