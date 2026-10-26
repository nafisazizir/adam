import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerMemoryScope } from "#lib/owner.js";
import {
  dueReminderMessage,
  isMissingReminderError,
  isRingingReminderTurn,
  reminderAuth,
  reminderDestination,
} from "#lib/reminders.js";

const owner = { issuer: "photon-imessage", principalId: "+15551234567" };

test("a reminder with a known owner runs as that owner under its own authenticator", () => {
  const auth = reminderAuth(owner, "msg_1");
  assert.equal(auth.principalType, "user");
  assert.equal(auth.principalId, owner.principalId);
  assert.equal(auth.issuer, owner.issuer);
  assert.equal(auth.authenticator, "reminders");
  assert.deepEqual(auth.attributes, { message_id: "msg_1" });
});

test("a reminder with a known owner shares the owner's memory scope", () => {
  const session = { auth: { current: reminderAuth(owner, null) } };
  assert.deepEqual(ownerMemoryScope({ session } as never), [owner.issuer, owner.principalId]);
});

test("without an owner a reminder falls back to the service principal", () => {
  const auth = reminderAuth(null, "msg_1");
  assert.equal(auth.principalType, "service");
  assert.equal(auth.authenticator, "qstash");
});

test("a known home pointer wins over the thread the reminder was set from", () => {
  const group = { channel: "photon", target: { threadId: "group" } };
  const home = { channel: "photon", target: { threadId: "dm" }, owner };
  assert.deepEqual(reminderDestination(group, home), { channel: "photon", target: { threadId: "dm" } });
  assert.deepEqual(reminderDestination(group, null), group);
});

test("only a 404 counts as a reminder that is already gone", () => {
  assert.equal(isMissingReminderError(Object.assign(new Error("x"), { status: 404 })), true);
  assert.equal(isMissingReminderError(Object.assign(new Error("x"), { status: 500 })), false);
  assert.equal(isMissingReminderError(new Error("x")), false);
  assert.equal(isMissingReminderError(null), false);
});

test("only a reminder the owner asked to be rung for may ring them", () => {
  const ringing = reminderAuth(owner, "msg_1", true);
  assert.deepEqual(ringing.attributes, { message_id: "msg_1", ring: "true" });
  assert.ok(isRingingReminderTurn(ringing));
  assert.ok(!isRingingReminderTurn(reminderAuth(owner, "msg_1")));
  assert.ok(!isRingingReminderTurn(reminderAuth(null, "msg_1", true)));
  assert.ok(!isRingingReminderTurn({ ...ringing, authenticator: "mail" }));
  assert.ok(!isRingingReminderTurn(null));
});

test("a ringing reminder tells Adam to call, and a plain one does not", () => {
  assert.equal(dueReminderMessage("stretch", false), "A reminder you scheduled earlier is now due: stretch");
  assert.ok(dueReminderMessage("wake up", true).includes("call call_owner"));
});
