import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConnectionAuthorizationRequiredError,
  type ConnectionPrincipal,
  type InteractiveAuthorizationDefinition,
  isConnectionAuthorizationFailedError,
} from "eve/connections";
import type { SessionAuthContext } from "eve/context";

import { signInFromOwnerDirectChat } from "#lib/connection-auth.js";
import { ownerAuth } from "#lib/owner.js";

const owner = { issuer: "photon-imessage", principalId: "+61400000000" };
const principal: ConnectionPrincipal = { type: "user", id: owner.principalId, issuer: owner.issuer };
const connection = { url: "https://mcp.example.test/mcp" };

function photon(direct: "true" | "false"): SessionAuthContext {
  return ownerAuth(owner, { authenticator: "photon-imessage", attributes: { thread_id: "t", direct } });
}

const workout = ownerAuth(owner, { authenticator: "workouts", attributes: { thread_id: "t" } });

function callerContext(current: SessionAuthContext | null) {
  return { session: { auth: { current } } };
}

function provider(getToken: InteractiveAuthorizationDefinition["getToken"]) {
  const evict = async () => {};
  return {
    principalType: "user",
    displayName: "Example",
    vercelConnect: { connector: "scl_example" },
    evict,
    getToken,
    startAuthorization: async () => ({ challenge: { url: "https://sign-in.example.test" } }),
    completeAuthorization: async () => ({ token: "fresh" }),
  } satisfies InteractiveAuthorizationDefinition;
}

const notSignedIn = provider(async () => {
  throw new ConnectionAuthorizationRequiredError("example");
});

test("the owner's direct chat gets the interactive sign-in", () => {
  const auth = signInFromOwnerDirectChat("Example", notSignedIn)(callerContext(photon("true")));
  assert.equal(auth, notSignedIn);
});

test("every other turn gets a provider that cannot start a sign-in", () => {
  const resolve = signInFromOwnerDirectChat("Example", notSignedIn);
  for (const current of [photon("false"), workout, null]) {
    const auth = resolve(callerContext(current));
    assert.equal("startAuthorization" in auth, false);
    assert.equal("completeAuthorization" in auth, false);
    assert.ok("credentialOwner" in auth && auth.credentialOwner === "user");
    assert.deepEqual(auth.vercelConnect, notSignedIn.vercelConnect);
    assert.equal(auth.evict, notSignedIn.evict);
    assert.equal(auth.displayName, "Example");
  }
});

test("outside the direct chat a stored grant still works", async () => {
  const signedIn = provider(async () => ({ token: "stored", expiresAt: 1 }));
  const auth = signInFromOwnerDirectChat("Example", signedIn)(callerContext(workout));
  assert.deepEqual(await auth.getToken({ principal, connection }), { token: "stored", expiresAt: 1 });
});

test("outside the direct chat a missing grant fails the call for good", async () => {
  const auth = signInFromOwnerDirectChat("Example", notSignedIn)(callerContext(workout));
  await assert.rejects(auth.getToken({ principal, connection }), (error) => {
    assert.ok(isConnectionAuthorizationFailedError(error));
    assert.equal(error.retryable, false);
    assert.equal(error.reason, "sign_in_needs_direct_chat");
    assert.match(error.message, /Example needs the user to sign in/u);
    return true;
  });
});

test("other token errors pass through untouched", async () => {
  const outage = new Error("connect is down");
  const failing = provider(async () => {
    throw outage;
  });
  const auth = signInFromOwnerDirectChat("Example", failing)(callerContext(photon("false")));
  await assert.rejects(auth.getToken({ principal, connection }), (error) => error === outage);
});
