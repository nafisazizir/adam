import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";

import {
  type DeliveryChannel,
  deliveryChannelByName,
  deliveryChannelForAuth,
  isOwnerChat,
  isOwnerDirectChat,
  pickDeliveryOn,
  pickHomeDelivery,
} from "#lib/delivery.js";
import type { HomeTarget } from "#lib/home-target.js";
import { ownerAuth, ownerIssuer } from "#lib/owner.js";
import { withinServiceWindow } from "#lib/whatsapp.js";

const owner = { issuer: ownerIssuer, principalId: "+61400000000" };

function chat(attributes: SessionAuthContext["attributes"]): SessionAuthContext {
  return ownerAuth(owner, { authenticator: "photon-imessage", attributes });
}

const direct = chat({ thread_id: "iMessage;-;+61400000000", direct: "true" });
const group = chat({ thread_id: "iMessage;+;chat123", direct: "false" });
const background = ["workouts", "coding-sessions", "briefing"].map((authenticator) =>
  ownerAuth(owner, { authenticator, attributes: { thread_id: "iMessage;-;+61400000000" } }),
);
const reminder: SessionAuthContext = {
  attributes: {},
  authenticator: "qstash",
  principalId: "reminders",
  principalType: "service",
};
const localDev: SessionAuthContext = {
  attributes: {},
  authenticator: "local-dev",
  principalId: "local-dev",
  principalType: "local-dev",
};

test("the owner chatting is an owner chat, in a direct thread or a group", () => {
  assert.equal(isOwnerChat(direct), true);
  assert.equal(isOwnerChat(group), true);
});

test("background turns, service callers and local dev are not owner chats", () => {
  for (const auth of [...background, reminder, localDev, null, undefined]) {
    assert.equal(isOwnerChat(auth), false);
  }
});

test("a photon turn with no thread is not an owner chat", () => {
  assert.equal(isOwnerChat(chat({})), false);
});

test("only the owner's direct thread is an owner direct chat", () => {
  assert.equal(isOwnerDirectChat(direct), true);
  assert.equal(isOwnerDirectChat(group), false);
  for (const auth of [...background, reminder, localDev, null, undefined]) {
    assert.equal(isOwnerDirectChat(auth), false);
  }
});

test("a chat turn that does not say it is direct is treated as a group", () => {
  assert.equal(isOwnerDirectChat(chat({ thread_id: "iMessage;-;+61400000000" })), false);
  assert.equal(isOwnerDirectChat(chat({ thread_id: "t", direct: ["true"] })), true);
  assert.equal(isOwnerDirectChat(chat({ thread_id: "t", direct: "1" })), false);
});

test("a background turn claiming to be direct is still not an owner direct chat", () => {
  const forged = ownerAuth(owner, {
    authenticator: "workouts",
    attributes: { thread_id: "iMessage;-;+61400000000", direct: "true" },
  });
  assert.equal(isOwnerDirectChat(forged), false);
});

const whatsappThread = "whatsapp:1234:61400000000";
const whatsappChat = ownerAuth(owner, {
  authenticator: "whatsapp",
  attributes: { thread_id: whatsappThread, direct: "true" },
});

test("the owner on WhatsApp is an owner direct chat, delivered back to the same thread", () => {
  assert.equal(isOwnerChat(whatsappChat), true);
  assert.equal(isOwnerDirectChat(whatsappChat), true);
  const resolved = deliveryChannelForAuth(whatsappChat);
  assert.equal(resolved?.channel.name, "whatsapp");
  assert.deepEqual(resolved?.target, { threadId: whatsappThread, adapterName: "whatsapp" });
});

test("a WhatsApp turn shares the iMessage owner's principal, so grants and memory follow", () => {
  assert.equal(whatsappChat.issuer, direct.issuer);
  assert.equal(whatsappChat.principalId, direct.principalId);
});

test("iMessage is always reachable; WhatsApp is not while it is not configured", () => {
  const now = Date.now();
  assert.equal(deliveryChannelByName("photon")?.canReach({ target: {} }, now), true);
  const fresh = { target: {}, lastInboundAt: new Date(now).toISOString() };
  assert.equal(deliveryChannelByName("whatsapp")?.canReach(fresh, now), false);
});

const now = Date.parse("2026-10-18T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();

function fakeChannel(name: string, canReach: DeliveryChannel["canReach"]): DeliveryChannel {
  return {
    name,
    canReach,
    targetFromAuth: () => null,
    deliver: async () => {
      throw new Error("not delivered in tests");
    },
  };
}

const channels = [
  fakeChannel("photon", () => true),
  fakeChannel("whatsapp", (presence, at) => withinServiceWindow(presence.lastInboundAt, at)),
];

const imessageTarget = { threadId: "iMessage;-;+61400000000", adapterName: "imessage" };
const whatsappTarget = { threadId: whatsappThread, adapterName: "whatsapp" };

function home(photonAt: string | undefined, whatsappAt: string | undefined): HomeTarget {
  return {
    channel: "photon",
    target: imessageTarget,
    owner,
    channels: {
      ...(photonAt && { photon: { target: imessageTarget, lastInboundAt: photonAt } }),
      ...(whatsappAt && { whatsapp: { target: whatsappTarget, lastInboundAt: whatsappAt } }),
    },
  };
}

const picked = (target: HomeTarget) => pickHomeDelivery(target, now, channels)?.channel.name;

test("a pointer without channels delivers to the iMessage home thread", () => {
  const legacy: HomeTarget = { channel: "photon", target: imessageTarget, owner };
  assert.deepEqual(pickHomeDelivery(legacy, now, channels), { channel: channels[0], target: imessageTarget });
});

test("Adam speaks up where the owner wrote last, while that channel can reach them", () => {
  assert.equal(picked(home(hoursAgo(5), hoursAgo(1))), "whatsapp");
  assert.equal(picked(home(hoursAgo(1), hoursAgo(5))), "photon");
  assert.equal(picked(home(undefined, hoursAgo(1))), "whatsapp");
});

test("once WhatsApp's window closes, iMessage takes over even if it is older", () => {
  assert.equal(picked(home(hoursAgo(72), hoursAgo(23.6))), "photon");
  assert.equal(picked(home(undefined, hoursAgo(30))), "photon");
});

test("a channel the pointer names but Adam cannot deliver on is skipped", () => {
  const target = home(hoursAgo(5), undefined);
  target.channels = { ...target.channels, telegram: { target: {}, lastInboundAt: hoursAgo(0) } };
  assert.equal(picked(target), "photon");
});

test("the WhatsApp delivery target is the thread it last heard from", () => {
  assert.deepEqual(pickHomeDelivery(home(hoursAgo(5), hoursAgo(1)), now, channels)?.target, whatsappTarget);
});

const pickedOn = (name: string, target: HomeTarget) => pickDeliveryOn(name, target, now, channels)?.channel.name;

test("a WhatsApp call's replies go to the owner's WhatsApp thread even if they last wrote on iMessage", () => {
  assert.equal(pickedOn("whatsapp", home(hoursAgo(1), hoursAgo(5))), "whatsapp");
  assert.deepEqual(pickDeliveryOn("whatsapp", home(hoursAgo(1), hoursAgo(5)), now, channels)?.target, whatsappTarget);
});

test("a WhatsApp call falls back to the home pick when its thread is closed or unknown", () => {
  assert.equal(pickedOn("whatsapp", home(hoursAgo(1), hoursAgo(30))), "photon");
  assert.equal(pickedOn("whatsapp", home(hoursAgo(1), undefined)), "photon");
});
