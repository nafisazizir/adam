import assert from "node:assert/strict";
import { test } from "node:test";

import { calendarChannelTokens, parseCalendarNotification } from "#lib/calendar-push.js";

const tokens = calendarChannelTokens("server-secret");
const subject = { account: "work", calendarId: "primary" };

function headers(fields: Record<string, string>): Headers {
  return new Headers(fields);
}

test("a channel token names its account and calendar and verifies for its own channel", () => {
  const token = tokens.sign("channel-1", subject);
  assert.ok(token.length <= 256);
  assert.deepEqual(tokens.verify("channel-1", token), subject);
});

test("a token copied to another channel, edited, or signed under another secret fails", () => {
  const token = tokens.sign("channel-1", subject);
  assert.equal(tokens.verify("channel-2", token), null);
  assert.equal(tokens.verify("channel-1", token.replace("account=work", "account=personal")), null);
  assert.equal(calendarChannelTokens("another-secret").verify("channel-1", token), null);
  assert.equal(tokens.verify("channel-1", "account=work&calendar=primary"), null);
  assert.equal(tokens.verify("channel-1", ""), null);
});

test("a notification carries the channel, the state and what the token names", () => {
  const token = tokens.sign("channel-1", subject);
  const parsed = parseCalendarNotification(
    headers({
      "X-Goog-Channel-ID": "channel-1",
      "X-Goog-Channel-Token": token,
      "X-Goog-Resource-State": "exists",
      "X-Goog-Resource-ID": "resource-1",
      "X-Goog-Message-Number": "7",
    }),
    tokens,
  );
  assert.deepEqual(parsed, { account: "work", calendarId: "primary", channelId: "channel-1", state: "exists" });
});

test("a notification without Adam's token, or missing a header, is not one", () => {
  const token = tokens.sign("channel-1", subject);
  assert.equal(
    parseCalendarNotification(headers({ "X-Goog-Channel-ID": "channel-1", "X-Goog-Resource-State": "exists" }), tokens),
    null,
  );
  assert.equal(
    parseCalendarNotification(headers({ "X-Goog-Channel-ID": "channel-1", "X-Goog-Channel-Token": token }), tokens),
    null,
  );
  assert.equal(
    parseCalendarNotification(
      headers({ "X-Goog-Channel-ID": "other", "X-Goog-Channel-Token": token, "X-Goog-Resource-State": "exists" }),
      tokens,
    ),
    null,
  );
});
