import assert from "node:assert/strict";
import { test } from "node:test";
import { localDateTimeToInstant } from "#lib/zoned-time.js";

const iso = (local: string, zone: string) => localDateTimeToInstant(local, zone).toISOString();

test("converts a fixed-offset zone", () => {
  assert.equal(iso("2026-10-03T06:00", "Australia/Brisbane"), "2026-10-02T20:00:00.000Z");
});

test("uses standard time before the Sydney October transition", () => {
  assert.equal(iso("2026-10-03T06:00", "Australia/Sydney"), "2026-10-02T20:00:00.000Z");
});

test("uses daylight time after the Sydney October transition", () => {
  assert.equal(iso("2026-10-05T06:00", "Australia/Sydney"), "2026-10-04T19:00:00.000Z");
});

test("rejects a time skipped by the Sydney spring-forward gap", () => {
  assert.throws(() => localDateTimeToInstant("2026-10-04T02:30", "Australia/Sydney"), /does not exist/);
});

test("picks the earlier instant for an ambiguous autumn time", () => {
  assert.equal(iso("2026-04-05T02:30", "Australia/Sydney"), "2026-04-04T15:30:00.000Z");
});

test("rejects malformed and impossible input", () => {
  assert.throws(() => localDateTimeToInstant("tomorrow 6am", "UTC"), /not a local date-time/);
  assert.throws(() => localDateTimeToInstant("2026-02-30T06:00", "UTC"), /not a real date/);
});
