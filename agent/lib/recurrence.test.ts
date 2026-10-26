import assert from "node:assert/strict";
import { test } from "node:test";

import { describeRecurrence, nextOccurrence, type Recurrence, recurrenceSchema } from "#lib/recurrence.js";

const brisbane = "Australia/Brisbane";
const sydney = "Australia/Sydney";

function next(rule: Recurrence, anchor: string, after: string, timeZone = brisbane): string {
  return nextOccurrence(rule, new Date(anchor), new Date(after), timeZone).toISOString();
}

test("an hourly rule first runs one interval after its anchor and stays on its grid", () => {
  const rule: Recurrence = { every: "hours", interval: 6 };
  assert.equal(next(rule, "2026-10-26T00:05:00Z", "2026-10-26T00:05:00Z"), "2026-10-26T06:05:00.000Z");
  assert.equal(next(rule, "2026-10-26T00:05:00Z", "2026-10-26T06:05:00Z"), "2026-10-26T12:05:00.000Z");
  assert.equal(next(rule, "2026-10-26T00:05:00Z", "2026-10-26T13:00:00Z"), "2026-10-26T18:05:00.000Z");
});

test("a daily rule runs later today when the time is still ahead, else tomorrow", () => {
  const rule: Recurrence = { every: "days", interval: 1, time: "08:00" };
  // 07:00 and 09:00 in Brisbane (UTC+10)
  assert.equal(next(rule, "2026-10-25T21:00:00Z", "2026-10-25T21:00:00Z"), "2026-10-25T22:00:00.000Z");
  assert.equal(next(rule, "2026-10-25T23:00:00Z", "2026-10-25T23:00:00Z"), "2026-10-26T22:00:00.000Z");
});

test("every three days counts from the anchor's local date", () => {
  const rule: Recurrence = { every: "days", interval: 3, time: "08:00" };
  const anchor = "2026-10-25T23:00:00Z"; // 09:00 Mon 26 Oct local, past today's slot
  assert.equal(next(rule, anchor, anchor), "2026-10-28T22:00:00.000Z");
  assert.equal(next(rule, anchor, "2026-10-28T22:00:00Z"), "2026-10-31T22:00:00.000Z");
});

test("every other Sunday runs this week's Sunday, then skips a week", () => {
  const rule: Recurrence = { every: "weeks", interval: 2, weekdays: ["sun"], time: "18:00" };
  const anchor = "2026-10-26T00:00:00Z"; // Mon 26 Oct local
  const first = next(rule, anchor, anchor);
  assert.equal(first, "2026-11-01T08:00:00.000Z");
  assert.equal(next(rule, anchor, first), "2026-11-15T08:00:00.000Z");
});

test("a weekday rule skips the weekend", () => {
  const rule: Recurrence = { every: "weeks", interval: 1, weekdays: ["mon", "tue", "wed", "thu", "fri"], time: "08:00" };
  // after 08:00 Fri 30 Oct local
  assert.equal(next(rule, "2026-10-26T00:00:00Z", "2026-10-29T23:00:00Z"), "2026-11-01T22:00:00.000Z");
});

test("a monthly rule on the 31st runs on a short month's last day", () => {
  const rule: Recurrence = { every: "months", interval: 1, day: 31, time: "09:00" };
  const anchor = "2026-10-01T00:00:00Z";
  assert.equal(next(rule, anchor, "2026-10-31T00:00:00Z"), "2026-11-29T23:00:00.000Z");
  assert.equal(next(rule, anchor, "2027-01-31T00:00:00Z"), "2027-02-27T23:00:00.000Z");
});

test("every three months stays on the anchor's month cycle", () => {
  const rule: Recurrence = { every: "months", interval: 3, day: 1, time: "09:00" };
  assert.equal(next(rule, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"), "2026-12-31T23:00:00.000Z");
});

test("a time inside a daylight-saving gap runs once the clock jumps past it", () => {
  const rule: Recurrence = { every: "days", interval: 1, time: "02:30" };
  // Sydney skips 02:00-03:00 on Sun 4 Oct 2026; 03:00 AEDT is 16:00Z
  assert.equal(next(rule, "2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z", sydney), "2026-10-03T16:00:00.000Z");
});

test("a rule never runs before its anchor", () => {
  const rule: Recurrence = { every: "days", interval: 1, time: "08:00" };
  assert.equal(next(rule, "2026-11-02T14:00:00Z", "2026-10-26T00:00:00Z"), "2026-11-02T22:00:00.000Z");
});

test("an hourly rule runs at most every six hours", () => {
  assert.equal(recurrenceSchema.safeParse({ every: "hours", interval: 5 }).success, false);
  assert.equal(recurrenceSchema.safeParse({ every: "hours", interval: 6 }).success, true);
});

test("describes each rule the way the user would say it", () => {
  assert.equal(describeRecurrence({ every: "hours", interval: 6 }), "every 6 hours");
  assert.equal(describeRecurrence({ every: "days", interval: 3, time: "08:00" }), "every 3 days at 08:00");
  assert.equal(
    describeRecurrence({ every: "weeks", interval: 2, weekdays: ["sun", "mon"], time: "18:00" }),
    "every 2 weeks on Monday, Sunday at 18:00",
  );
  assert.equal(describeRecurrence({ every: "months", interval: 1, day: 1, time: "09:00" }), "every month on day 1 at 09:00");
});
