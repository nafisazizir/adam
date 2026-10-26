import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";

import { afterCallAuth, liveCallAuth } from "#lib/calls.js";
import type { ClaimStore, StoredClaim } from "#lib/daily-claim.js";
import { ownerAuth } from "#lib/owner.js";
import { reminderAuth } from "#lib/reminders.js";
import { outboundLine, ringOnceKey, type RingOwnerDeps, ringOwner, ringOwnerRefusal } from "#lib/ring-owner.js";
import { CallNotPlaced, type OutboundCall, type OutboundLine } from "#lib/voice.js";

const owner = { issuer: "photon-imessage", principalId: "+61412345678" };
const chat = ownerAuth(owner, { authenticator: "photon-imessage", attributes: { thread_id: "iMessage;-;+61412345678", direct: "true" } });
const now = Date.UTC(2026, 9, 26, 20, 30, 0);

test("the owner's chat and a reminder they asked to be rung for may ring them", () => {
  assert.equal(ringOwnerRefusal(chat), null);
  assert.equal(ringOwnerRefusal(reminderAuth(owner, "msg_1", true)), null);
});

test("no turn carrying someone else's words may ring the owner", () => {
  const others: (SessionAuthContext | null)[] = [
    null,
    reminderAuth(owner, "msg_1"),
    reminderAuth(null, "msg_1", true),
    liveCallAuth(owner, { conversationId: "conv_1" }, now + 25_000),
    afterCallAuth(owner, { conversationId: "conv_1" }),
    ...["mail", "coding-sessions", "workouts", "briefing"].map((authenticator) =>
      ownerAuth(owner, { authenticator, attributes: { thread_id: "iMessage;-;+61412345678", ring: "true" } }),
    ),
  ];
  for (const auth of others) assert.notEqual(ringOwnerRefusal(auth), null, auth?.authenticator ?? "no auth");
});

test("calling out needs the key, Adam's number and the tool secret", () => {
  assert.deepEqual(outboundLine({ apiKey: "k", fromNumber: "+61290000000", toolSecret: "s" }), {
    apiKey: "k",
    fromNumber: "+61290000000",
  });
  assert.equal(outboundLine({ apiKey: "k", fromNumber: "+61290000000" }), null);
  assert.equal(outboundLine({ fromNumber: "+61290000000", toolSecret: "s" }), null);
  assert.equal(outboundLine({ apiKey: "k", toolSecret: "s" }), null);
});

function memoryBudget() {
  const stored = new Map<string, StoredClaim>();
  let version = 0;
  const store: ClaimStore = {
    async read(job) {
      return stored.get(job) ?? null;
    },
    async write(job, day, expected) {
      const current = stored.get(job);
      const matches = expected === "absent" ? current === undefined : current?.etag === expected.etag;
      if (!matches) throw new Error("conflict");
      version += 1;
      stored.set(job, { day, etag: `e${version}` });
      return { etag: `e${version}` };
    },
    async remove(job, etag) {
      if (stored.get(job)?.etag !== etag) throw new Error("conflict");
      stored.delete(job);
    },
  };
  return { store, value: (job = "outbound-calls") => stored.get(job)?.day ?? null };
}

const line: OutboundLine = { apiKey: "k", fromNumber: "+61290000000" };

function deps(overrides: Partial<RingOwnerDeps> = {}) {
  const placed: OutboundCall[] = [];
  const budget = memoryBudget();
  const value: RingOwnerDeps = {
    line,
    owner: async () => ({ handles: ["owner@icloud.com", "+61412345678"], record: { kind: "absent" } }),
    budget: budget.store,
    place: async (_line, call) => {
      placed.push(call);
      return { conversationId: "conv_out" };
    },
    now: () => now,
    ...overrides,
  };
  return { deps: value, placed, budget };
}

test("rings the owner's phone number with the reason", async () => {
  const ring = deps();
  assert.deepEqual(await ringOwner("Your 7am flight is cancelled.", ring.deps), { rung: true, conversationId: "conv_out" });
  assert.equal(ring.placed.length, 1);
  assert.equal(ring.placed[0]?.toNumber, "+61412345678");
  assert.equal(ring.placed[0]?.briefing.greeting, "Hey, it's Adam. Your 7am flight is cancelled.");
  assert.equal(ring.budget.value(), String(now));
});

test("a second call inside the gap is refused without dialling", async () => {
  const ring = deps();
  await ringOwner("first", ring.deps);
  const again = await ringOwner("second", { ...ring.deps, now: () => now + 60_000 });
  assert.equal(again.rung, false);
  assert.match(!again.rung ? again.error : "", /already rang them recently/u);
  assert.equal(ring.placed.length, 1);
});

test("a call that certainly did not go out gives its slot back", async () => {
  const ring = deps({
    place: async () => {
      throw new CallNotPlaced("geo permissions");
    },
  });
  const failed = await ringOwner("x", ring.deps);
  assert.match(!failed.rung ? failed.error : "", /did not go out \(geo permissions\)/u);
  assert.equal(ring.budget.value(), "");
});

test("a call that may have gone out keeps its slot, so a retry can't ring twice", async () => {
  const ring = deps({
    place: async () => {
      throw new Error("ElevenLabs POST returned 502");
    },
  });
  const failed = await ringOwner("x", ring.deps);
  assert.ok(!failed.rung && failed.uncertain);
  assert.match(!failed.rung ? failed.error : "", /may have gone out/u);
  assert.equal(ring.budget.value(), String(now));
  assert.equal((await ringOwner("x", { ...ring.deps, now: () => now + 60_000 })).rung, false);
});

test("a ringing reminder rings once, however late QStash redelivers it", async () => {
  const auth = reminderAuth(owner, "msg:1", true);
  const key = ringOnceKey(auth);
  assert.equal(key, "ring-msg_1");
  assert.equal(ringOnceKey(reminderAuth(owner, "msg:1")), undefined);
  assert.equal(ringOnceKey(chat), undefined);

  const ring = deps();
  assert.equal((await ringOwner("wake up", ring.deps, key)).rung, true);
  const later = await ringOwner("wake up", { ...ring.deps, now: () => now + 60 * 60_000 }, key);
  assert.match(!later.rung ? later.error : "", /already rang them/u);
  assert.equal(ring.placed.length, 1);
});

test("a ringing reminder whose call certainly failed can ring on a redelivery", async () => {
  let attempts = 0;
  const ring = deps({
    place: async () => {
      attempts += 1;
      if (attempts === 1) throw new CallNotPlaced("not imported");
      return { conversationId: "conv_out" };
    },
  });
  assert.equal((await ringOwner("wake up", ring.deps, "ring-msg_2")).rung, false);
  assert.equal(ring.budget.value("ring-msg_2"), null);
  assert.equal((await ringOwner("wake up", ring.deps, "ring-msg_2")).rung, true);
});

test("refuses clearly when calling is not set up or there is no number to ring", async () => {
  const unset = deps({ line: null });
  assert.match((await ringOwner("x", unset.deps) as { error: string }).error, /ELEVENLABS_API_KEY/u);

  const emailOnly = deps({ owner: async () => ({ handles: ["owner@icloud.com"], record: { kind: "absent" } }) });
  assert.match((await ringOwner("x", emailOnly.deps) as { error: string }).error, /OWNER_IMESSAGE_HANDLES/u);
  assert.equal(unset.placed.length + emailOnly.placed.length, 0);
  assert.equal(emailOnly.budget.value(), null);
});

test("a budget that can't be read means no call", async () => {
  const ring = deps({
    budget: {
      read: async () => {
        throw new Error("blob down");
      },
      write: async () => ({ etag: "x" }),
      remove: async () => {},
    },
  });
  assert.equal((await ringOwner("x", ring.deps)).rung, false);
  assert.equal(ring.placed.length, 0);
});
