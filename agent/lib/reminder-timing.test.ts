import assert from "node:assert/strict";
import { test } from "node:test";
import { reminderTiming } from "#lib/reminder-timing.js";

const now = Date.parse("2026-10-03T00:00:00.300Z");
const minutes = (count: number) => now + count * 60_000;

test("a relative delay always schedules", () => {
  assert.deepEqual(reminderTiming({ delaySeconds: 30 }, now), {
    kind: "schedule",
    delaySeconds: 30,
    fireAtMs: now + 30_000,
  });
});

test("a plain clock time schedules at exactly the target", () => {
  const result = reminderTiming({ targetMs: minutes(3), leadMinutes: 0 }, now);
  assert.deepEqual(result, { kind: "schedule", delaySeconds: 180, fireAtMs: minutes(3) });
});

test("a plain clock time in the past is an error, not a skip", () => {
  assert.deepEqual(reminderTiming({ targetMs: now - 1000, leadMinutes: 0 }, now), { kind: "past" });
  assert.deepEqual(reminderTiming({ targetMs: now, leadMinutes: 0 }, now), { kind: "past" });
});

test("a lead reminder fires lead minutes before the target", () => {
  const result = reminderTiming({ targetMs: minutes(180), leadMinutes: 15 }, now);
  assert.deepEqual(result, { kind: "schedule", delaySeconds: 165 * 60, fireAtMs: minutes(165) });
});

test("a lead reminder under five minutes away is skipped", () => {
  assert.deepEqual(reminderTiming({ targetMs: minutes(19), leadMinutes: 15 }, now), { kind: "skipped" });
  assert.deepEqual(reminderTiming({ targetMs: minutes(10), leadMinutes: 15 }, now), { kind: "skipped" });
  assert.deepEqual(reminderTiming({ targetMs: now - 60_000, leadMinutes: 15 }, now), { kind: "skipped" });
});

test("a lead reminder exactly five minutes away schedules", () => {
  assert.equal(reminderTiming({ targetMs: minutes(20), leadMinutes: 15 }, now).kind, "schedule");
});
