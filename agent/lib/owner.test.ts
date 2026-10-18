import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";

import { admitSender, ownerAuth, ownerMemoryNamespace, ownerMemoryScope, sameHandle } from "#lib/owner.js";

const owner = { issuer: "photon-imessage", principalId: "user-1" };

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

const ownerHandle = "+61412345678";
const stranger = "+61499999999";
const direct = (id: string) => ({ id, isDirect: true });
const group = (id: string) => ({ id, isDirect: false });

test("accepts the first direct sender when no ownerHandle is known", () => {
  assert.deepEqual(admitSender(direct(stranger), {}), { admitted: true, updatesHome: true });
});

test("a group chat never claims ownership", () => {
  assert.deepEqual(admitSender(group(stranger), {}), { admitted: false });
});

test("rejects anyone but the recorded owner", () => {
  assert.deepEqual(admitSender(direct(stranger), { recorded: ownerHandle }), { admitted: false });
  assert.deepEqual(admitSender(direct(ownerHandle), { recorded: ownerHandle }), {
    admitted: true,
    updatesHome: true,
  });
});

test("the pinned ownerHandle beats the recorded one", () => {
  const known = { pinned: ownerHandle, recorded: stranger };
  assert.deepEqual(admitSender(direct(stranger), known), { admitted: false });
  assert.deepEqual(admitSender(direct(ownerHandle), known), { admitted: true, updatesHome: true });
});

test("in a group only the ownerHandle gets through, and the home thread stays put", () => {
  assert.deepEqual(admitSender(group(ownerHandle), { recorded: ownerHandle }), {
    admitted: true,
    updatesHome: false,
  });
  assert.deepEqual(admitSender(group(stranger), { recorded: ownerHandle }), { admitted: false });
});

test("rejects a sender with no handle", () => {
  assert.deepEqual(admitSender(direct(""), {}), { admitted: false });
  assert.deepEqual(admitSender(direct("  "), { recorded: ownerHandle }), { admitted: false });
});

test("matches handles across formatting but not across near-misses", () => {
  assert.ok(sameHandle("+61 412 345 678", ownerHandle));
  assert.ok(sameHandle("Me@iCloud.com ", "me@icloud.com"));
  assert.ok(!sameHandle("first-last@icloud.com", "firstlast@icloud.com"));
  assert.ok(!sameHandle("+61412345679", ownerHandle));
});
