import assert from "node:assert/strict";
import { test } from "node:test";

import { calendarChannelTokens, parseCalendarNotification } from "#lib/calendar-push.js";

const tokens = calendarChannelTokens("server-secret");
const subject = { account: "work", calendarId: "primary" };
const now = new Date("2026-10-26T00:00:00Z");
const ends = new Date("2026-11-02T00:00:00Z");

test("a channel token names its account and calendar and verifies for its own channel until it ends", () => {
  const token = tokens.sign("channel-1", subject, ends);
  assert.ok(token.length <= 256);
  assert.deepEqual(tokens.verify("channel-1", token, now), subject);
  assert.deepEqual(tokens.verify("channel-1", token, ends), subject);
  assert.equal(tokens.verify("channel-1", token, new Date(ends.getTime() + 1000)), null);
});

test("a token copied to another channel, edited, or signed under another secret fails", () => {
  const token = tokens.sign("channel-1", subject, ends);
  assert.equal(tokens.verify("channel-2", token, now), null);
  assert.equal(tokens.verify("channel-1", token.replace("account=work", "account=personal"), now), null);
  assert.equal(tokens.verify("channel-1", token.replace(/exp=\d+/u, "exp=9999999999"), now), null);
  assert.equal(calendarChannelTokens("another-secret").verify("channel-1", token, now), null);
  assert.equal(tokens.verify("channel-1", "account=work&calendar=primary", now), null);
  assert.equal(tokens.verify("channel-1", "", now), null);
});

test("a notification carries the channel, the state and what the token names", () => {
  const parsed = parseCalendarNotification(
    new Headers({
      "X-Goog-Channel-ID": "channel-1",
      "X-Goog-Channel-Token": tokens.sign("channel-1", subject, ends),
      "X-Goog-Resource-State": "exists",
      "X-Goog-Resource-ID": "resource-1",
      "X-Goog-Message-Number": "7",
    }),
    tokens,
    now,
  );
  assert.deepEqual(parsed, { account: "work", calendarId: "primary", channelId: "channel-1", state: "exists" });
});

test("a notification without Adam's token, or missing a header, is not one", () => {
  const token = tokens.sign("channel-1", subject, ends);
  const parse = (fields: Record<string, string>) => parseCalendarNotification(new Headers(fields), tokens, now);
  assert.equal(parse({ "X-Goog-Channel-ID": "channel-1", "X-Goog-Resource-State": "exists" }), null);
  assert.equal(parse({ "X-Goog-Channel-ID": "channel-1", "X-Goog-Channel-Token": token }), null);
  assert.equal(parse({ "X-Goog-Channel-ID": "other", "X-Goog-Channel-Token": token, "X-Goog-Resource-State": "exists" }), null);
});
