import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

import { isAuthenticPush, parseMailboxNotification, type PushVerifier } from "#lib/pubsub-push.js";

const audience = "https://adam.test/eve/v1/mail/push";
const serviceAccount = "pubsub-push@adam-project.iam.gserviceaccount.com";

const google = await generateKeyPair("RS256");
const stranger = await generateKeyPair("RS256");
const googleJwk = { ...(await exportJWK(google.publicKey)), kid: "google-1", alg: "RS256", use: "sig" };

const verifier: PushVerifier = {
  audience,
  serviceAccount,
  keys: createLocalJWKSet({ keys: [googleJwk] }),
};

async function pushToken(
  claims: JWTPayload = {},
  options: { key?: CryptoKey; expiresIn?: string | number; issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT({ email: serviceAccount, email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "google-1" })
    .setIssuer(options.issuer ?? "https://accounts.google.com")
    .setAudience(options.audience ?? audience)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(options.key ?? google.privateKey);
}

test("a Google-signed token for our route and push service account is accepted", async () => {
  assert.equal(await isAuthenticPush(`Bearer ${await pushToken()}`, verifier), true);
});

test("Google's issuer without the scheme is accepted too", async () => {
  const token = await pushToken({}, { issuer: "accounts.google.com" });
  assert.equal(await isAuthenticPush(`Bearer ${token}`, verifier), true);
});

test("a token minted for another audience is refused", async () => {
  assert.equal(await isAuthenticPush(`Bearer ${await pushToken({}, { audience: "https://elsewhere.test/push" })}`, verifier), false);
});

test("a token for another service account is refused", async () => {
  const token = await pushToken({ email: "someone@else.iam.gserviceaccount.com" });
  assert.equal(await isAuthenticPush(`Bearer ${token}`, verifier), false);
});

test("an unverified email is refused", async () => {
  assert.equal(await isAuthenticPush(`Bearer ${await pushToken({ email_verified: false })}`, verifier), false);
});

test("an expired token is refused", async () => {
  const token = await pushToken({}, { expiresIn: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(await isAuthenticPush(`Bearer ${token}`, verifier), false);
});

test("a token signed by a key Google did not publish is refused", async () => {
  assert.equal(await isAuthenticPush(`Bearer ${await pushToken({}, { key: stranger.privateKey })}`, verifier), false);
});

test("another issuer is refused", async () => {
  assert.equal(await isAuthenticPush(`Bearer ${await pushToken({}, { issuer: "https://evil.example" })}`, verifier), false);
});

test("a missing or malformed authorization header is refused", async () => {
  assert.equal(await isAuthenticPush(null, verifier), false);
  assert.equal(await isAuthenticPush("Basic abc", verifier), false);
  assert.equal(await isAuthenticPush("Bearer not-a-jwt", verifier), false);
});

function envelope(data: unknown) {
  return {
    message: { data: Buffer.from(JSON.stringify(data)).toString("base64"), messageId: "1" },
    subscription: "projects/p/subscriptions/gmail",
  };
}

test("a Gmail notification yields its address and history id", () => {
  assert.deepEqual(parseMailboxNotification(envelope({ emailAddress: "me@gmail.example", historyId: 9876543 })), {
    emailAddress: "me@gmail.example",
    historyId: "9876543",
  });
});

test("a malformed push yields nothing", () => {
  assert.equal(parseMailboxNotification(null), null);
  assert.equal(parseMailboxNotification({ message: {} }), null);
  assert.equal(parseMailboxNotification({ message: { data: "not base64 json" } }), null);
  assert.equal(parseMailboxNotification(envelope({ emailAddress: "me@gmail.example" })), null);
  assert.equal(parseMailboxNotification(envelope({ emailAddress: "me@gmail.example", historyId: "12a" })), null);
});
