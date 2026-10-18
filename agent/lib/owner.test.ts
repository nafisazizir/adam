import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";

import type { HomeTargetRead } from "#lib/home-target.js";
import {
  admitSender,
  type OwnerRecord,
  ownerAuth,
  ownerMemoryNamespace,
  ownerMemoryScope,
  ownerIssuer,
  ownerRecordLookup,
  sameHandle,
} from "#lib/owner.js";
import { waIdToE164 } from "#lib/whatsapp.js";

const owner = { issuer: ownerIssuer, principalId: "user-1" };

function scopeFor(current: SessionAuthContext | null) {
  return ownerMemoryScope({ session: { id: "session", auth: { current, initiator: current } } });
}

test("every trigger acting as the owner shares one memory scope", () => {
  const chat = scopeFor(ownerAuth(owner, { authenticator: "photon-imessage", attributes: {} }));
  const workout = scopeFor(ownerAuth(owner, { authenticator: "workouts", attributes: {} }));
  const coding = scopeFor(ownerAuth(owner, { authenticator: "coding-sessions", attributes: {} }));
  assert.deepEqual(chat, ["photon-imessage", "user-1"]);
  assert.deepEqual(workout, chat);
  assert.deepEqual(coding, chat);
});

test("service turns and anonymous callers get no memory", () => {
  const reminder: SessionAuthContext = {
    attributes: {},
    authenticator: "qstash",
    principalId: "reminders",
    principalType: "service",
  };
  assert.equal(scopeFor(reminder), null);
  assert.equal(scopeFor(null), null);
});

test("a user without an issuer gets no memory rather than a blank scope component", () => {
  assert.equal(
    scopeFor({ attributes: {}, authenticator: "x", principalId: "user-1", principalType: "user" }),
    null,
  );
});

test("local development shares one scope", () => {
  assert.equal(
    scopeFor({ attributes: {}, authenticator: "local-dev", principalId: "local", principalType: "local-dev" }),
    "local-dev",
  );
});

const local = { onVercel: false, environment: undefined };

test("root and subagents resolve the same namespace", () => {
  const root = ownerMemoryNamespace({ appRoot: "/app", node: "__root__", slot: "owner" }, local);
  const coach = ownerMemoryNamespace({ appRoot: "/app", node: "coach", slot: "owner" }, local);
  assert.equal(coach, root);
});

function withEnv(t: { after(fn: () => void): void }) {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  return (vars: Record<string, string>) => {
    process.env = { ...saved, ...vars };
    return ownerMemoryNamespace(
      { appRoot: "/app", node: "__root__", slot: "owner" },
      { onVercel: true, environment: vars.VERCEL_ENV },
    );
  };
}

test("production keeps one namespace across deployments, previews get their own", (t) => {
  const namespaceFor = withEnv(t);
  const project = { VERCEL_PROJECT_ID: "prj_adam" };
  const production = namespaceFor({ ...project, VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_1" });
  assert.ok(production);
  assert.equal(namespaceFor({ ...project, VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_2" }), production);
  assert.notEqual(namespaceFor({ ...project, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feat/x" }), production);
});

test("on Vercel without the project or environment, memory is off rather than shared", (t) => {
  const namespaceFor = withEnv(t);
  t.mock.method(console, "warn", () => {});
  assert.equal(namespaceFor({ VERCEL_PROJECT_ID: "", VERCEL_OIDC_TOKEN: "", VERCEL_ENV: "preview" }), null);
  assert.equal(namespaceFor({ VERCEL_PROJECT_ID: "prj_adam" }), null);
});

const issuer = owner.issuer;
const phone = "+61412345678";
const email = "owner@icloud.com";
const stranger = "+61499999999";
const direct = (id: string) => ({ id, isDirect: true, service: "imessage" as const });
const group = (id: string) => ({ id, isDirect: false, service: "imessage" as const });
const whatsapp = (waId: string) => ({ id: waIdToE164(waId) ?? "", isDirect: true, service: "whatsapp" as const });
const absent: OwnerRecord = { kind: "absent" };
const recorded = (principalId: string): OwnerRecord => ({ kind: "recorded", principalId });
const none = { handles: [], record: absent };

test("with no owner known, the first direct sender claims it", () => {
  assert.deepEqual(admitSender(direct(stranger), none), {
    admitted: true,
    principalId: stranger,
    claimed: true,
    updatesHome: true,
  });
});

test("a group chat never claims ownership", () => {
  assert.equal(admitSender(group(stranger), none).admitted, false);
});

test("rejects anyone but the recorded owner", () => {
  const owner = { handles: [], record: recorded(phone) };
  assert.equal(admitSender(direct(stranger), owner).admitted, false);
  assert.deepEqual(admitSender(direct(phone), owner), {
    admitted: true,
    principalId: phone,
    claimed: false,
    updatesHome: true,
  });
});

test("a phone number and an email of the same person are different handles", () => {
  assert.equal(admitSender(direct(email), { handles: [], record: recorded(phone) }).admitted, false);
});

test("every listed alias acts as the recorded principal when it is listed", () => {
  const owner = { handles: [email, phone], record: recorded(phone) };
  const admission = admitSender(direct(email), owner);
  assert.ok(admission.admitted);
  assert.equal(admission.principalId, phone);
  assert.equal(admitSender(direct(phone), owner).admitted, true);
  assert.equal(admitSender(direct(stranger), owner).admitted, false);
});

test("a handle list that leaves the recorded owner out locks them out and takes over", () => {
  const owner = { handles: [phone], record: recorded(stranger) };
  assert.equal(admitSender(direct(stranger), owner).admitted, false);
  const admission = admitSender(direct(phone), owner);
  assert.ok(admission.admitted);
  assert.equal(admission.principalId, phone);
});

test("a listed handle used as the principal is canonical", () => {
  const owner = { handles: ["+61 412 345 678", email], record: absent };
  const admission = admitSender(direct(email), owner);
  assert.ok(admission.admitted);
  assert.equal(admission.principalId, phone);
  const emailFirst = admitSender(direct(phone), { handles: ["Owner@iCloud.com", phone], record: absent });
  assert.ok(emailFirst.admitted);
  assert.equal(emailFirst.principalId, email);
});

test("with no pointer, listed handles act as the first one and nobody else can claim", () => {
  const owner = { handles: [phone, email], record: absent };
  const admission = admitSender(direct(email), owner);
  assert.ok(admission.admitted);
  assert.equal(admission.principalId, phone);
  assert.equal(admission.claimed, false);
  assert.equal(admitSender(direct(stranger), owner).admitted, false);
});

test("in a group only the owner gets through, and the home thread stays put", () => {
  for (const owner of [{ handles: [], record: recorded(phone) }, { handles: [phone], record: absent }]) {
    const admission = admitSender(group(phone), owner);
    assert.ok(admission.admitted);
    assert.equal(admission.updatesHome, false);
    assert.equal(admitSender(group(stranger), owner).admitted, false);
  }
});

test("an unusable pointer drops everyone, even a listed handle", () => {
  const record: OwnerRecord = { kind: "invalid", reason: "not JSON" };
  assert.equal(admitSender(direct(stranger), { handles: [], record }).admitted, false);
  assert.equal(admitSender(direct(phone), { handles: [phone], record }).admitted, false);
});

test("without a Blob store only listed handles get in", () => {
  const record: OwnerRecord = { kind: "unconfigured" };
  assert.equal(admitSender(direct(stranger), { handles: [], record }).admitted, false);
  assert.equal(admitSender(direct(phone), { handles: [phone], record }).admitted, true);
});

test("rejects senders with no handle or not on iMessage", () => {
  assert.equal(admitSender(direct(""), none).admitted, false);
  assert.equal(admitSender(direct("  "), { handles: [], record: recorded(phone) }).admitted, false);
  const sms = { id: phone, isDirect: true, service: "sms-or-rcs" as const };
  assert.equal(admitSender(sms, { handles: [phone], record: recorded(phone) }).admitted, false);
});

test("matches handles across formatting but not across near-misses", () => {
  assert.ok(sameHandle("+61 412 345 678", phone));
  assert.ok(sameHandle("Owner@iCloud.com ", email));
  assert.ok(!sameHandle("first-last@icloud.com", "firstlast@icloud.com"));
  assert.ok(!sameHandle("+61412345679", phone));
  assert.ok(!sameHandle("Kate@icloud.com", "kate@icloud.com"));
});

test("the owner's issuer never changes, or their grants, memory and home pointer are orphaned", () => {
  assert.equal(ownerIssuer, "photon-imessage");
});

test("the recorded owner's number gets in over WhatsApp as the same principal", () => {
  const admission = admitSender(whatsapp("61412345678"), { handles: [], record: recorded(phone) });
  assert.deepEqual(admission, { admitted: true, principalId: phone, claimed: false, updatesHome: true });
  assert.equal(admitSender(whatsapp("61499999999"), { handles: [], record: recorded(phone) }).admitted, false);
});

test("a number in the iMessage handle list gets in over WhatsApp as the listed principal", () => {
  const owner = { handles: [email, "+61 412 345 678"], record: recorded(email) };
  const admission = admitSender(whatsapp("61412345678"), owner);
  assert.ok(admission.admitted);
  assert.equal(admission.principalId, email);
});

test("a WhatsApp-only number gets in only when OWNER_WHATSAPP_NUMBERS lists it", () => {
  const indonesian = "6281234567890";
  const owner = { handles: [phone], record: recorded(phone) };
  assert.equal(admitSender(whatsapp(indonesian), owner).admitted, false);
  const listed = admitSender(whatsapp(indonesian), { ...owner, whatsappNumbers: ["+62 812 3456 7890"] });
  assert.ok(listed.admitted);
  assert.equal(listed.principalId, phone);
});

test("a handle list that leaves the recorded owner out also locks their number out of WhatsApp", () => {
  const owner = { handles: [email], record: recorded(phone) };
  assert.equal(admitSender(whatsapp("61412345678"), owner).admitted, false);
});

test("WhatsApp never claims ownership, even from a listed number", () => {
  for (const record of [absent, { kind: "unconfigured" } as OwnerRecord]) {
    const owner = { handles: [phone], whatsappNumbers: [phone], record };
    assert.equal(admitSender(whatsapp("61412345678"), owner).admitted, false);
  }
  const broken: OwnerRecord = { kind: "invalid", reason: "not JSON" };
  assert.equal(admitSender(whatsapp("61412345678"), { handles: [phone], record: broken }).admitted, false);
});

test("a WhatsApp sender with only a username id is never the owner", () => {
  const owner = { handles: [phone], whatsappNumbers: [phone], record: recorded(phone) };
  assert.equal(admitSender(whatsapp("US.13491208655302741918"), owner).admitted, false);
});

function fakeStore(...reads: (HomeTargetRead | Error)[]) {
  let calls = 0;
  const read = async () => {
    const next = reads[Math.min(calls++, reads.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { read, calls: () => calls };
}

const found = (principalId: string, ownerIssuer = issuer): HomeTargetRead => ({
  status: "found",
  home: { channel: "photon", target: {}, owner: { issuer: ownerIssuer, principalId } },
});

test("a failed Blob read is unusable, not absent", async () => {
  const lookup = ownerRecordLookup(fakeStore(new Error("blob down")).read, issuer);
  assert.deepEqual(await lookup.current(), { kind: "invalid", reason: "blob down" });
});

test("a pointer from another issuer is unusable", async () => {
  const lookup = ownerRecordLookup(fakeStore(found(phone, "slack")).read, issuer);
  assert.equal((await lookup.current()).kind, "invalid");
});

test("only a 404 means no owner yet", async () => {
  const invalid: HomeTargetRead = { status: "invalid", reason: "not JSON" };
  assert.equal((await ownerRecordLookup(fakeStore(invalid).read, issuer).current()).kind, "invalid");
  const missing = ownerRecordLookup(fakeStore({ status: "absent" }).read, issuer);
  assert.equal((await missing.current()).kind, "absent");
});

test("caches a recorded owner but retries everything else", async () => {
  const store = fakeStore(new Error("blob down"), { status: "absent" }, found(phone), found(stranger));
  const lookup = ownerRecordLookup(store.read, issuer);
  assert.equal((await lookup.current()).kind, "invalid");
  assert.equal((await lookup.current()).kind, "absent");
  assert.deepEqual(await lookup.current(), recorded(phone));
  assert.deepEqual(await lookup.current(), recorded(phone));
  assert.equal(store.calls(), 3);
});

test("a claim is remembered without another read", async () => {
  const store = fakeStore({ status: "absent" });
  const lookup = ownerRecordLookup(store.read, issuer);
  lookup.remember(phone);
  assert.deepEqual(await lookup.current(), recorded(phone));
  assert.equal(store.calls(), 0);
});

test("a claim is cached only once it is written", async () => {
  const store = fakeStore({ status: "absent" });
  const lookup = ownerRecordLookup(store.read, issuer);
  const taken = async () => {
    throw new Error("blob already exists");
  };
  assert.equal(await lookup.claim(stranger, taken), false);
  assert.equal((await lookup.current()).kind, "absent");
  assert.equal(await lookup.claim(phone, async () => {}), true);
  assert.deepEqual(await lookup.current(), recorded(phone));
  assert.equal(store.calls(), 1);
});
