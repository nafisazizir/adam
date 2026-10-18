import assert from "node:assert/strict";
import { test } from "node:test";
import { sentOverIMessage } from "#lib/photon-inbound.js";

test("accepts a webhook sender on the iMessage platform", () => {
  assert.ok(sentOverIMessage({ sender: { id: "+15550100", platform: "iMessage" } }));
  assert.ok(sentOverIMessage({ platform: "iMessage", sender: { id: "+15550100" } }));
});

test("the sender's service beats the platform", () => {
  const sms = { sender: { id: "+15550100", platform: "iMessage", service: "SMS" } };
  assert.ok(!sentOverIMessage(sms));
  assert.ok(!sentOverIMessage({ sender: { id: "+15550100", service: "RCS" } }));
  assert.ok(sentOverIMessage({ sender: { id: "+15550100", service: "iMessage" } }));
});

test("fails closed when nothing names the service", () => {
  assert.ok(!sentOverIMessage({ sender: { id: "+15550100" } }));
  assert.ok(!sentOverIMessage(null));
  assert.ok(!sentOverIMessage({ sender: { id: "+15550100", service: 1 } }));
});
