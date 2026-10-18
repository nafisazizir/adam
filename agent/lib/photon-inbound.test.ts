import assert from "node:assert/strict";
import { test } from "node:test";
import { sentOverAnotherService } from "#lib/photon-inbound.js";

test("accepts a webhook sender on the iMessage platform", () => {
  assert.ok(!sentOverAnotherService({ sender: { id: "+15550100", platform: "iMessage" } }));
  assert.ok(!sentOverAnotherService({ platform: "iMessage", sender: { id: "+15550100" } }));
});

test("the sender's service beats the platform", () => {
  const sms = { sender: { id: "+15550100", platform: "iMessage", service: "SMS" } };
  assert.ok(sentOverAnotherService(sms));
  assert.ok(sentOverAnotherService({ sender: { id: "+15550100", service: "RCS" } }));
  assert.ok(sentOverAnotherService({ sender: { id: "+15550100", service: "sms" } }));
  assert.ok(!sentOverAnotherService({ sender: { id: "+15550100", service: "iMessage" } }));
});

test("does not refuse a sender when nothing names the service", () => {
  assert.ok(!sentOverAnotherService({ sender: { id: "+15550100" } }));
  assert.ok(!sentOverAnotherService(null));
  assert.ok(!sentOverAnotherService({ sender: { id: "+15550100", service: 1 } }));
  assert.ok(!sentOverAnotherService({ sender: { id: "+15550100", service: "unknown" } }));
});
