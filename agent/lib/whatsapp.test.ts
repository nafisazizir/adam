import assert from "node:assert/strict";
import { test } from "node:test";

import { admitSender } from "#lib/owner.js";
import { isBusinessScopedUserId, normalizeOwnerNumbers, waIdToE164, withinServiceWindow } from "#lib/whatsapp.js";

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

test("owner numbers listed as bare digits match the sender WhatsApp reports", () => {
  assert.deepEqual(normalizeOwnerNumbers(["6281234567890", "+61412345678", "+62 812 3456 7890"]), [
    "+6281234567890",
    "+61412345678",
    "+62 812 3456 7890",
  ]);

  const sender = { id: waIdToE164("6281234567890")!, isDirect: true, service: "whatsapp" as const };
  const record = { kind: "recorded" as const, principalId: "+61412345678" };
  assert.equal(admitSender(sender, { handles: [], whatsappNumbers: ["6281234567890"], record }).admitted, false);
  const admitted = admitSender(sender, { handles: [], whatsappNumbers: normalizeOwnerNumbers(["6281234567890"]), record });
  assert.equal(admitted.admitted, true);
});
