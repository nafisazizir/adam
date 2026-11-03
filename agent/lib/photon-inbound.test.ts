import assert from "node:assert/strict";
import { test } from "node:test";
import { fillInboundWithoutContent, sentOverAnotherService } from "#lib/photon-inbound.js";

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

test("a contact card becomes text instead of being dropped", () => {
  const message = {
    text: "",
    attachments: [],
    raw: {
      content: {
        type: "contact",
        name: { formatted: "Jane Doe" },
        phones: [{ value: "+61 400 000 000" }],
        raw: "BEGIN:VCARD\r\nitem1.URL;type=pref:https\\://maps.apple.com/?ll=-33.86\\,151.2\r\nEND:VCARD",
      },
    },
  };
  assert.equal(fillInboundWithoutContent(message), null);
  assert.equal(
    message.text,
    "[Shared a contact card: Jane Doe, +61 400 000 000, https://maps.apple.com/?ll=-33.86\\,151.2]",
  );
});

test("leaves a message with text or files alone and reports what it cannot read", () => {
  const withText = { text: "hi", attachments: [], raw: { content: { type: "contact" } } };
  assert.equal(fillInboundWithoutContent(withText), null);
  assert.equal(withText.text, "hi");

  const unknown = { text: "", attachments: [], raw: { content: { type: "custom", raw: {} } } };
  assert.deepEqual(fillInboundWithoutContent(unknown), { contentType: "custom", contentKeys: ["type", "raw"] });
  assert.equal(unknown.text, "");
});
