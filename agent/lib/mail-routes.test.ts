import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { GoogleNeedsConnectingError, type EmailSummary } from "#lib/google.js";
import { mailPushHandler, mailRunHandler, type MailHome, type MailPushDeps } from "#lib/mail-routes.js";
import { MailboxStateConflict, type MailboxReader, type MailboxState, type MailboxStateStore } from "#lib/new-mail.js";
import { memoryCache } from "#lib/shared-cache.js";

const audience = "https://adam.test/eve/v1/mail/push";
const serviceAccount = "push@adam.iam.gserviceaccount.com";
const google = await generateKeyPair("RS256");
const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(google.publicKey)), kid: "k1", alg: "RS256", use: "sig" }],
});

async function bearer(): Promise<string> {
  const token = await new SignJWT({ email: serviceAccount, email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(google.privateKey);
  return `Bearer ${token}`;
}

function pushRequest(authorization: string | null, body: unknown): Request {
  return new Request(audience, {
    method: "POST",
    headers: authorization ? { authorization, "content-type": "application/json" } : {},
    body: JSON.stringify(body),
  });
}

function gmailPush(emailAddress = "me@gmail.example") {
  const data = Buffer.from(JSON.stringify({ emailAddress, historyId: 42 })).toString("base64");
  return { message: { data, messageId: "1" }, subscription: "projects/p/subscriptions/s" };
}

function pushHandler(overrides: Partial<MailPushDeps> = {}) {
  const published: unknown[] = [];
  const handler = mailPushHandler({
    audience,
    serviceAccount,
    keys: () => keys,
    cache: memoryCache(),
    today: () => "2026-10-18",
    now: () => new Date("2026-10-18T01:00:05Z"),
    publish: async (run) => void published.push(run),
    ...overrides,
  });
  return { handler, published };
}

test("a push is refused when no push service account is configured", async () => {
  const { handler, published } = pushHandler({ serviceAccount: undefined });
  const response = await handler(pushRequest(await bearer(), gmailPush()));
  assert.equal(response.status, 401);
  assert.equal(published.length, 0);
});

test("a push without a valid token is refused", async () => {
  const { handler, published } = pushHandler();
  assert.equal((await handler(pushRequest(null, gmailPush()))).status, 401);
  assert.equal((await handler(pushRequest("Bearer forged", gmailPush()))).status, 401);
  assert.equal(published.length, 0);
});

test("an authentic but malformed push is acknowledged without queueing a run", async () => {
  const { handler, published } = pushHandler();
  const response = await handler(pushRequest(await bearer(), { emailAddress: "unwrapped@example.com", historyId: 1 }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ignored: "invalid_payload" });
  assert.equal(published.length, 0);
});

test("a burst of pushes queues one run for the window", async () => {
  const { handler, published } = pushHandler();
  for (let i = 0; i < 3; i += 1) assert.equal((await handler(pushRequest(await bearer(), gmailPush()))).status, 200);
  assert.equal(published.length, 1);
  assert.deepEqual((published[0] as { body: unknown }).body, { emailAddress: "me@gmail.example" });
});

test("a failed publish answers 500 so Pub/Sub retries, and the window is not marked queued", async () => {
  let fail = true;
  const { handler } = pushHandler({
    publish: async () => {
      if (fail) throw new Error("qstash down");
    },
  });
  assert.equal((await handler(pushRequest(await bearer(), gmailPush()))).status, 500);
  fail = false;
  const retried = await handler(pushRequest(await bearer(), gmailPush()));
  assert.deepEqual(await retried.json(), { ok: true });
});

const owner = { issuer: "photon-imessage", principalId: "+61400000000" };

function inbox(): MailboxReader {
  const mail: EmailSummary = {
    account: "personal",
    id: "a",
    threadId: "a",
    from: "Mia <mia@example.com>",
    to: "me@gmail.example",
    subject: "dinner?",
    date: new Date(),
    snippet: "can you make 6:30?",
    unread: true,
    important: true,
    category: "primary",
  };
  return {
    history: async () => ({ addedMessageIds: ["a"], historyId: "120", nextPageToken: null }),
    summaries: async (ids) => (ids.includes("a") ? [mail] : []),
    recentUnread: async () => [],
    currentHistoryId: async () => "120",
  };
}

function store(initial: MailboxState | null, write?: MailboxStateStore["write"]): MailboxStateStore {
  let doc = initial ? { state: initial, etag: "e0" } : null;
  return {
    read: async () => doc,
    write:
      write ??
      (async (_account, next) => {
        doc = { state: next, etag: "e1" };
        return { etag: "e1" };
      }),
  };
}

function runRequest(body: unknown, messageId = "msg-1"): Request {
  return new Request("https://adam.test/eve/v1/mail/process", {
    method: "POST",
    headers: { "upstash-message-id": messageId },
    body: JSON.stringify(body),
  });
}

function runHandler(overrides: { verify?: boolean; account?: string | null | Error; mailboxStore?: MailboxStateStore } = {}) {
  const messages: string[] = [];
  const handler = mailRunHandler({
    store: overrides.mailboxStore ?? store({ historyId: "100", checkpointedAt: Date.now(), delivered: [] }),
    cache: memoryCache(),
    timeContext: () => "time",
    verify: async () => overrides.verify ?? true,
    accountWithAddress: async () => {
      if (overrides.account instanceof Error) throw overrides.account;
      return overrides.account === undefined ? "personal" : overrides.account;
    },
    reader: () => inbox(),
  });
  const home = async (): Promise<MailHome> => ({ owner, deliver: async (message) => void messages.push(message) });
  return { handler, home, messages };
}

test("a mailbox run without a valid QStash signature is refused", async () => {
  const { handler, home, messages } = runHandler({ verify: false });
  assert.equal((await handler(runRequest({ emailAddress: "me@gmail.example" }), home)).status, 401);
  assert.equal(messages.length, 0);
});

test("a mailbox run delivers one <new_email> to the home thread", async () => {
  const { handler, home, messages } = runHandler();
  const response = await handler(runRequest({ emailAddress: "me@gmail.example" }), home);
  assert.deepEqual(await response.json(), { ok: true, kind: "delivered", count: 1 });
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /<new_email account="personal">/u);
});

test("a mailbox run for an unknown address or an account that needs connecting is acknowledged", async () => {
  const unknown = runHandler({ account: null });
  assert.deepEqual(await (await unknown.handler(runRequest({ emailAddress: "x@y" }), unknown.home)).json(), {
    ok: true,
    ignored: "unknown_mailbox",
  });
  const disconnected = runHandler({ account: new GoogleNeedsConnectingError("personal", "is not connected") });
  const response = await disconnected.handler(runRequest({ emailAddress: "me@gmail.example" }), disconnected.home);
  assert.deepEqual(await response.json(), { ok: true, ignored: "needs_connecting" });
});

test("a transient failure answers 500 and a lost write race answers 409, so QStash retries both", async () => {
  const flaky = runHandler({ account: new Error("userinfo 503") });
  assert.equal((await flaky.handler(runRequest({ emailAddress: "me@gmail.example" }), flaky.home)).status, 500);

  const racing = runHandler({
    mailboxStore: store({ historyId: "100", checkpointedAt: Date.now(), delivered: [] }, async () => {
      throw new MailboxStateConflict("changed");
    }),
  });
  const response = await racing.handler(runRequest({ emailAddress: "me@gmail.example" }), racing.home);
  assert.equal(response.status, 409);
  assert.equal(racing.messages.length, 0);
});

test("a mailbox run with no home target is acknowledged", async () => {
  const { handler } = runHandler();
  const response = await handler(runRequest({ emailAddress: "me@gmail.example" }), async () => null);
  assert.deepEqual(await response.json(), { ok: true, ignored: "no_home_target" });
});
