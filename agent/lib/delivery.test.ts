import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";

import { isOwnerChat, isOwnerDirectChat } from "#lib/delivery.js";
import { ownerAuth } from "#lib/owner.js";

const owner = { issuer: "photon-imessage", principalId: "+61400000000" };

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
