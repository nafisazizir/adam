import assert from "node:assert/strict";
import { test } from "node:test";

import { homeChannels, parseHomeTarget, withPresence, withPrimary, type HomeTarget } from "#lib/home-target.js";

const owner = { issuer: "photon-imessage", principalId: "+61412345678" };
const imessage = { threadId: "iMessage;-;+61412345678", adapterName: "imessage" };
const whatsapp = { threadId: "whatsapp:1234:61412345678", adapterName: "whatsapp" };

// The shape every pointer written before WhatsApp has.
const legacyJson = `{"channel":"photon","target":{"threadId":"iMessage;-;+61412345678","adapterName":"imessage"},"owner":{"issuer":"photon-imessage","principalId":"+61412345678"}}`;

const legacy: HomeTarget = { channel: "photon", target: imessage, owner };

test("a pointer written before channels existed still parses unchanged", () => {
  assert.deepEqual(parseHomeTarget(JSON.parse(legacyJson)), legacy);
});

test("a pointer with channels parses them", () => {
  const home = { ...legacy, channels: { whatsapp: { target: whatsapp, lastInboundAt: "2026-10-18T01:00:00.000Z" } } };
  assert.deepEqual(parseHomeTarget(JSON.parse(JSON.stringify(home))), home);
});

test("a malformed channels map is dropped instead of making the pointer unusable", () => {
  for (const channels of ["nope", { whatsapp: { target: "x" } }, { whatsapp: { target: {}, lastInboundAt: "yesterday" } }]) {
    assert.deepEqual(parseHomeTarget({ ...legacy, channels }), { ...legacy, channels: undefined });
  }
});

test("a pointer missing the owner is still unusable", () => {
  assert.equal(parseHomeTarget({ channel: "photon", target: imessage }), null);
});

test("the primary channel is always reached at the top-level target", () => {
  const home: HomeTarget = {
    ...legacy,
    channels: {
      photon: { target: { threadId: "old" }, lastInboundAt: "2026-10-18T01:00:00.000Z" },
      whatsapp: { target: whatsapp },
    },
  };
  assert.deepEqual(homeChannels(home), {
    photon: { target: imessage, lastInboundAt: "2026-10-18T01:00:00.000Z" },
    whatsapp: { target: whatsapp },
  });
  assert.deepEqual(homeChannels(legacy), { photon: { target: imessage } });
});

const at = (minute: number) => new Date(Date.parse("2026-10-18T01:00:00.000Z") + minute * 60_000).toISOString();

test("writing the primary keeps every other channel", () => {
  const current: HomeTarget = { ...legacy, channels: { whatsapp: { target: whatsapp, lastInboundAt: at(0) } } };
  const moved = { ...legacy, target: { threadId: "iMessage;-;owner@icloud.com", adapterName: "imessage" } };
  assert.deepEqual(withPrimary(current, moved), { ...moved, channels: current.channels });
  assert.deepEqual(withPrimary(null, legacy), legacy);
  assert.equal(withPrimary(current, legacy), null);
});

test("a channel's presence is added to the pointer without touching the primary", () => {
  const presence = { target: whatsapp, lastInboundAt: at(0) };
  assert.deepEqual(withPresence(legacy, "whatsapp", presence), { ...legacy, channels: { whatsapp: presence } });
});

test("presence is refreshed about every ten minutes, never backwards", () => {
  const current = withPresence(legacy, "whatsapp", { target: whatsapp, lastInboundAt: at(0) });
  assert.equal(withPresence(current, "whatsapp", { target: whatsapp, lastInboundAt: at(9) }), null);
  assert.equal(withPresence(current, "whatsapp", { target: whatsapp, lastInboundAt: at(-30) }), null);
  assert.equal(withPresence(current, "whatsapp", { target: whatsapp, lastInboundAt: at(10) })?.channels?.whatsapp?.lastInboundAt, at(10));
});

test("a new thread on the same channel is written straight away", () => {
  const current = withPresence(legacy, "whatsapp", { target: whatsapp, lastInboundAt: at(0) });
  const other = { threadId: "whatsapp:5678:61412345678", adapterName: "whatsapp" };
  assert.deepEqual(withPresence(current, "whatsapp", { target: other, lastInboundAt: at(1) })?.channels?.whatsapp, {
    target: other,
    lastInboundAt: at(1),
  });
});

test("presence never creates a pointer", () => {
  assert.equal(withPresence(null, "whatsapp", { target: whatsapp, lastInboundAt: at(0) }), null);
});

test("each channel's presence is kept when another one writes", () => {
  const both = withPresence(
    withPresence(legacy, "photon", { target: imessage, lastInboundAt: at(0) }),
    "whatsapp",
    { target: whatsapp, lastInboundAt: at(1) },
  );
  assert.deepEqual(Object.keys(both?.channels ?? {}).sort(), ["photon", "whatsapp"]);
});
