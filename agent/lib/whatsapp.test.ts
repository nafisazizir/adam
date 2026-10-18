import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inboundMessageClaimKey,
  isBusinessScopedUserId,
  waIdToE164,
  withinServiceWindow,
} from "#lib/whatsapp.js";

test("a wa_id becomes the E.164 number owner handles use", () => {
  assert.equal(waIdToE164("61412345678"), "+61412345678");
  assert.equal(waIdToE164(" 6281234567890 "), "+6281234567890");
  assert.equal(waIdToE164("+61412345678"), "+61412345678");
});

test("anything but a plain number is not a phone number", () => {
  for (const id of ["", "  ", "US.13491208655302741918", "6141234567a", "+", "123456", "1234567890123456"]) {
    assert.equal(waIdToE164(id), null, id);
  }
});

test("recognises a business-scoped user id", () => {
  assert.ok(isBusinessScopedUserId("US.13491208655302741918"));
  assert.ok(isBusinessScopedUserId("AU.ENT.abc123"));
  assert.ok(!isBusinessScopedUserId("61412345678"));
});

const now = Date.parse("2026-10-18T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();

test("the service window stays open for 23.5 hours after the owner's last message", () => {
  assert.ok(withinServiceWindow(hoursAgo(0), now));
  assert.ok(withinServiceWindow(hoursAgo(23.4), now));
  assert.ok(!withinServiceWindow(hoursAgo(23.5), now));
  assert.ok(!withinServiceWindow(hoursAgo(25), now));
});

test("no message or an unreadable time keeps the window closed", () => {
  assert.ok(!withinServiceWindow(undefined, now));
  assert.ok(!withinServiceWindow("not a date", now));
});

test("a message's claim key is stable, path-safe and distinct per message", () => {
  const key = inboundMessageClaimKey("wamid.HBgLNjE0MTIzNDU2NzgVAgASGBQzRUIwQ0Y5RjE=");
  assert.equal(key, inboundMessageClaimKey("wamid.HBgLNjE0MTIzNDU2NzgVAgASGBQzRUIwQ0Y5RjE="));
  assert.match(key, /^whatsapp-message-[0-9a-f]{32}$/u);
  assert.notEqual(key, inboundMessageClaimKey("wamid.other"));
});
