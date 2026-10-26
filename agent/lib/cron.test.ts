import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyCron, lastDailyRun } from "#lib/cron.js";

const winter = new Date("2026-07-01T00:00:00Z");

test("7am in Brisbane is 21:00 UTC the day before", () => {
  assert.equal(dailyCron({ hour: 7 }, "Australia/Brisbane", winter), "0 21 * * *");
});

test("keeps the local minute and half-hour offsets", () => {
  assert.equal(dailyCron({ hour: 7 }, "Asia/Kolkata", winter), "30 1 * * *");
  assert.equal(dailyCron({ hour: 7, minute: 15 }, "UTC", winter), "15 7 * * *");
});

test("wraps forward for zones behind UTC", () => {
  assert.equal(dailyCron({ hour: 22 }, "America/New_York", winter), "0 2 * * *");
});

test("follows daylight saving at the given instant", () => {
  assert.equal(dailyCron({ hour: 7 }, "Australia/Sydney", winter), "0 21 * * *");
  assert.equal(dailyCron({ hour: 7 }, "Australia/Sydney", new Date("2026-12-01T00:00:00Z")), "0 20 * * *");
});

test("a daily run is anchored to when it was due, however late within the hour it ran", () => {
  const due = (now: string) => lastDailyRun("0 20 * * *", new Date(now)).toISOString();
  assert.equal(due("2026-10-25T20:00:00Z"), "2026-10-25T20:00:00.000Z");
  assert.equal(due("2026-10-25T20:59:00Z"), "2026-10-25T20:00:00.000Z");
});

test("a daily run shifted an hour by daylight saving since the build is anchored to its own hour", () => {
  assert.equal(lastDailyRun("0 20 * * *", new Date("2026-10-25T21:40:00Z")).toISOString(), "2026-10-25T21:00:00.000Z");
  assert.equal(lastDailyRun("0 21 * * *", new Date("2026-10-25T20:10:00Z")).toISOString(), "2026-10-25T20:00:00.000Z");
  assert.equal(lastDailyRun("0 21 * * *", new Date("2026-10-25T21:10:00Z")).toISOString(), "2026-10-25T21:00:00.000Z");
});

test("a daily run keeps its minute and crosses midnight UTC", () => {
  assert.equal(lastDailyRun("30 23 * * *", new Date("2026-10-26T00:10:00Z")).toISOString(), "2026-10-25T23:30:00.000Z");
  assert.equal(lastDailyRun("30 0 * * *", new Date("2026-10-26T00:10:00Z")).toISOString(), "2026-10-25T23:30:00.000Z");
});

test("only a daily cron is anchored", () => {
  assert.throws(() => lastDailyRun("*/5 * * * *", new Date()), /not a daily cron/u);
});
