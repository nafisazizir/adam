import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyCron } from "#lib/cron.js";

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
