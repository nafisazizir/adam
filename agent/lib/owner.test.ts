import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";

import { ownerAuth, ownerMemoryNamespace, ownerMemoryScope } from "#lib/owner.js";

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

test("root and subagents resolve the same namespace", () => {
  const root = ownerMemoryNamespace({ appRoot: "/app", node: "__root__", slot: "owner" });
  const coach = ownerMemoryNamespace({ appRoot: "/app", node: "coach", slot: "owner" });
  assert.equal(coach, root);
});

test("production keeps one namespace across deployments, previews get their own", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  const namespaceFor = (vars: Record<string, string>) => {
    process.env = { ...saved, VERCEL_PROJECT_ID: "prj_adam", ...vars };
    return ownerMemoryNamespace({ appRoot: "/app", node: "__root__", slot: "owner" });
  };
  const production = namespaceFor({ VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_1" });
  assert.equal(namespaceFor({ VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_2" }), production);
  assert.notEqual(namespaceFor({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feat/x" }), production);
});
