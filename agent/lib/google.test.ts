import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectError, type ConnectTokenParams, UserAuthorizationRequiredError } from "@vercel/connect";

import {
  decodeEncodedWords,
  emailBody,
  type GoogleConnect,
  googleScopes,
  googleSubject,
  googleWorkspace,
  GoogleNeedsConnectingError,
  htmlToText,
  trimQuotedReply,
  truncate,
} from "#lib/google.js";
import {
  googleAccountRegistry,
  GoogleAccountsConflict,
  type GoogleAccountRecord,
  type GoogleAccountStore,
} from "#lib/google-accounts.js";
import { memoryCache } from "#lib/shared-cache.js";

const b64 = (text: string) => Buffer.from(text).toString("base64url");

const owner = { issuer: "photon-imessage", principalId: "+61400000000" };
const connector = "scl_google";
const both = ["personal", "work"];

interface TokenCall {
  readonly connector: string;
  readonly params: ConnectTokenParams;
  readonly forceRefresh: boolean;
}

function labelOf(params: { subject: ConnectTokenParams["subject"] }): string {
  const { subject } = params;
  return subject.type === "user" ? (subject.id.split("/google/")[1] ?? "") : "";
}

// An account mapped to a token has a grant; one mapped to an error fails with it; one left out
// has never been connected.
function fakeConnect(grants: Record<string, string | Error>, options: { revokeError?: Error } = {}) {
  const tokenCalls: TokenCall[] = [];
  const started: { connector: string; params: ConnectTokenParams }[] = [];
  const revoked: string[] = [];
  const connect: GoogleConnect = {
    async getToken(connectorId, params, tokenOptions) {
      tokenCalls.push({ connector: connectorId, params, forceRefresh: tokenOptions?.forceRefresh ?? false });
      const grant = grants[labelOf(params)];
      if (grant instanceof Error) throw grant;
      if (grant === undefined) throw new UserAuthorizationRequiredError("User authorization is required");
      return tokenOptions?.forceRefresh ? `${grant}-fresh` : grant;
    },
    async startAuthorization(connectorId, params) {
      started.push({ connector: connectorId, params });
      return {
        url: `https://connect.test/authorize/${labelOf(params)}`,
        expiresAt: Date.parse("2026-10-18T01:00:00Z"),
      };
    },
    async revokeToken(_connectorId, params) {
      if (options.revokeError) throw options.revokeError;
      const label = labelOf(params);
      if (grants[label] === undefined) throw new ConnectError("no token", { status: 404 });
      revoked.push(label);
      delete grants[label];
    },
  };
  return { connect, tokenCalls, started, revoked };
}

function fakeAccountStore(labels: readonly string[]) {
  let version = 0;
  let accounts: GoogleAccountRecord[] = labels.map((label) => ({ label, addedAt: "2026-10-01T00:00:00.000Z" }));
  const store: GoogleAccountStore & { labels(): string[] } = {
    labels: () => accounts.map((account) => account.label),
    async read() {
      return { accounts: [...accounts], etag: String(version) };
    },
    async write(next, expected) {
      if (expected === "absent" || expected.etag !== String(version)) throw new GoogleAccountsConflict("stale");
      accounts = next;
      version += 1;
    },
  };
  return store;
}

type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;

function fakeFetch(...routes: Route[]) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

function bearer(init: RequestInit | undefined): string | undefined {
  return new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
}

function addresses(byToken: Record<string, string>): Route {
  return (url, init) =>
    url.hostname === "openidconnect.googleapis.com"
      ? Response.json({ email: byToken[bearer(init) ?? ""] ?? "unknown@example.com" })
      : undefined;
}

function workspace(
  labels: readonly string[],
  connect: GoogleConnect,
  fetchImpl: typeof fetch,
  store: GoogleAccountStore = fakeAccountStore(labels),
) {
  return googleWorkspace({
    connector,
    accounts: googleAccountRegistry({ store, cache: memoryCache(), cacheTtlSeconds: 60 }),
    connect,
    timeZone: "Australia/Brisbane",
    fetch: fetchImpl,
    sleep: async () => {},
  });
}

const personal = ["personal"];

test("prefers text/plain inside nested multipart and lists attachments without their data", () => {
  const { text, attachments } = emailBody({
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64("Plain body ✓") } },
          { mimeType: "text/html", body: { data: b64("<p>HTML body</p>") } },
        ],
      },
      { mimeType: "application/pdf", filename: "invoice.pdf", body: { size: 1234, attachmentId: "att-1" } },
    ],
  });
  assert.equal(text, "Plain body ✓");
  assert.deepEqual(attachments, [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 1234 }]);
});

test("falls back to html converted to text", () => {
  const html =
    "<html><head><style>p{}</style></head><body><p>Hi&nbsp;there &amp; welcome</p><ul><li>one</li><li>two</li></ul>bye<br>now</body></html>";
  const { text } = emailBody({ mimeType: "text/html", body: { data: b64(html) } });
  assert.equal(text, "Hi there & welcome\n- one\n- two\nbye\nnow");
});

test("decodes a declared charset", () => {
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64url");
  const { text } = emailBody({
    mimeType: "text/plain",
    headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }],
    body: { data: latin1 },
  });
  assert.equal(text, "café");
});

test("trims the quoted reply below the new text", () => {
  const text = "Sounds good.\n\nOn Mon, 6 Oct 2026 at 9:00, Bob <bob@example.com> wrote:\n> earlier\n> more";
  assert.equal(trimQuotedReply(text), "Sounds good.");
  assert.equal(trimQuotedReply("> only quoted"), "> only quoted");
});

test("decodes RFC 2047 encoded words, including a character split across words", () => {
  assert.equal(decodeEncodedWords("=?UTF-8?B?SGVsbG8g8J+Riw==?= world"), "Hello 👋 world");
  assert.equal(decodeEncodedWords("=?utf-8?Q?caf=C3?= =?utf-8?Q?=A9_time?="), "café time");
  assert.equal(decodeEncodedWords("plain subject"), "plain subject");
});

test("html to text strips scripts and comments", () => {
  assert.equal(htmlToText("<script>alert(1)</script><!-- x -->ok &#39;quoted&#x27;"), "ok 'quoted'");
});

test("truncation never splits a surrogate pair", () => {
  const cut = truncate(`${"a".repeat(7999)}😀tail`, 8000);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, `${"a".repeat(7999)}…`);
});

const message = {
  id: "m1",
  threadId: "t1",
  labelIds: ["UNREAD", "INBOX"],
  snippet: "see you &amp; bring snacks",
  internalDate: "1790000000000",
  payload: {
    headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "Subject", value: "=?UTF-8?Q?Pic=C3=B1ic?=" },
    ],
  },
};

const oneMessage: Route = (url) => {
  if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }] });
  if (url.pathname.endsWith("/messages/m1")) return Response.json(message);
  return undefined;
};

test("each account is its own Connect subject under the owner, on the one connector", () => {
  assert.deepEqual(googleSubject(owner, "work"), {
    type: "user",
    id: "+61400000000/google/work",
    issuer: "photon-imessage",
  });
  assert.notDeepEqual(googleSubject(owner, "work"), googleSubject(owner, "personal"));
});

test("tokens come from the one connector, as that account's subject, with the Gmail and Calendar scopes", async () => {
  const { connect, tokenCalls } = fakeConnect({ personal: "token-personal", work: "token-work" });
  const { impl, calls } = fakeFetch(oneMessage);
  await workspace(both, connect, impl).searchEmail(owner, "in:inbox", { max: 5 });
  assert.ok(tokenCalls.every((call) => call.connector === connector && !call.forceRefresh));
  assert.deepEqual(tokenCalls.find((call) => labelOf(call.params) === "personal")?.params, {
    subject: googleSubject(owner, "personal"),
    scopes: [...googleScopes],
  });
  assert.deepEqual(tokenCalls.find((call) => labelOf(call.params) === "work")?.params.subject, googleSubject(owner, "work"));
  assert.deepEqual(
    [...new Set(calls.map((call) => bearer(call.init)))].sort(),
    ["token-personal", "token-work"],
  );
});

test("an account with no grant is reported as needing connecting without hiding the others", async () => {
  const { connect } = fakeConnect({ personal: "token-personal" });
  const { impl } = fakeFetch(oneMessage);
  const found = await workspace(both, connect, impl).searchEmail(owner, "in:inbox", { max: 5 });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0]?.account, "personal");
  assert.equal(found.results[0]?.subject, "Picñic");
  assert.equal(found.results[0]?.snippet, "see you & bring snacks");
  assert.equal(found.results[0]?.unread, true);
  assert.equal(found.errors.length, 1);
  assert.equal(found.errors[0]?.account, "work");
  assert.equal(found.errors[0]?.needsConnecting, true);
  assert.match(found.errors[0]?.error ?? "", /only goes out when the user asks in a direct chat/u);
});

test("a Connect outage is an error for that account, not a request to connect it", async () => {
  const { connect } = fakeConnect({ personal: new ConnectError("Failed to get token: 503") });
  const { impl } = fakeFetch();
  const found = await workspace(personal, connect, impl).searchEmail(owner, "x", { max: 5 });
  assert.deepEqual(found.errors, [{ account: "personal", error: "Failed to get token: 503", needsConnecting: false }]);
});

test("a 401 asks Connect for a fresh token once and retries", async () => {
  const { connect, tokenCalls } = fakeConnect({ personal: "token" });
  const { impl } = fakeFetch((url, init) => {
    if (!url.pathname.endsWith("/messages")) return undefined;
    return bearer(init) === "token" ? new Response("expired", { status: 401 }) : Response.json({ messages: [] });
  });
  const found = await workspace(personal, connect, impl).searchEmail(owner, "is:unread", { max: 5 });
  assert.deepEqual(
    tokenCalls.map((call) => call.forceRefresh),
    [false, true],
  );
  assert.deepEqual(found, { results: [], errors: [], truncated: false });
});

test("a 401 after a fresh token means the account needs connecting", async () => {
  const { connect, tokenCalls } = fakeConnect({ personal: "token" });
  const { impl } = fakeFetch((url) =>
    url.pathname.endsWith("/messages") ? new Response("revoked", { status: 401 }) : undefined,
  );
  const found = await workspace(personal, connect, impl).searchEmail(owner, "is:unread", { max: 5 });
  assert.deepEqual(
    tokenCalls.map((call) => call.forceRefresh),
    [false, true],
  );
  assert.equal(found.errors[0]?.needsConnecting, true);
});

test("an account is named by its label or by its address", async () => {
  const { connect } = fakeConnect({ personal: "token-personal", work: "token-work" });
  const { impl, calls } = fakeFetch(
    addresses({ "token-personal": "me@gmail.example", "token-work": "me@work.example" }),
    (url) => (url.pathname.endsWith("/messages/m1") ? Response.json(message) : undefined),
  );
  const google = workspace(both, connect, impl);

  const email = await google.readEmail(owner, "Me@Work.example", "m1");
  assert.equal(email.account, "work");
  assert.equal(bearer(calls.at(-1)?.init), "token-work");

  await google.readEmail(owner, "PERSONAL", "m1");
  assert.equal(bearer(calls.at(-1)?.init), "token-personal");

  await assert.rejects(
    google.readEmail(owner, "someone@else.example", "m1"),
    /not one of the user's Google accounts: personal \(me@gmail\.example\), work \(me@work\.example\)/u,
  );
});

test("reading from an account with no grant says it needs connecting", async () => {
  const { connect } = fakeConnect({});
  const { impl } = fakeFetch();
  await assert.rejects(workspace(personal, connect, impl).readEmail(owner, "personal", "m1"), GoogleNeedsConnectingError);
});

test("without a connector the tools say Google isn't configured", async () => {
  const google = googleWorkspace({
    connector: undefined,
    accounts: googleAccountRegistry({ store: fakeAccountStore(both), cache: memoryCache(), cacheTtlSeconds: 60 }),
    connect: fakeConnect({}).connect,
    timeZone: "Australia/Brisbane",
  });
  assert.equal(google.configured, false);
  await assert.rejects(google.searchEmail(owner, "x", { max: 1 }), /set GOOGLE_CONNECTOR to/u);
  await assert.rejects(google.signIn(owner, "work"), /set GOOGLE_CONNECTOR to/u);
});

test("with no account yet, a read says how to add one and listing is empty", async () => {
  const google = workspace([], fakeConnect({}).connect, fakeFetch().impl);
  assert.equal(google.configured, true);
  assert.deepEqual(await google.listAccounts(owner), []);
  await assert.rejects(google.searchEmail(owner, "x", { max: 1 }), /No Google account is connected yet/u);
});

test("a turn with no user identity cannot read Google", async () => {
  const { connect, tokenCalls } = fakeConnect({ personal: "token" });
  await assert.rejects(
    workspace(personal, connect, fakeFetch().impl).searchEmail(null, "x", { max: 1 }),
    /no user identity/u,
  );
  assert.equal(tokenCalls.length, 0);
});

test("accounts list their address, or that they need connecting", async () => {
  const { connect } = fakeConnect({ personal: "token-personal" });
  const { impl } = fakeFetch(addresses({ "token-personal": "me@gmail.example" }));
  const accounts = await workspace(both, connect, impl).listAccounts(owner);
  assert.deepEqual(accounts, [
    { account: "personal", email: "me@gmail.example", status: "connected" },
    { account: "work", email: null, status: "needs_connecting" },
  ]);
});

test("connecting a new name adds it to the list and links its own subject, with the same scopes", async () => {
  const { connect, started, tokenCalls } = fakeConnect({ personal: "token-personal" });
  const store = fakeAccountStore(["personal"]);
  const google = workspace(["personal"], connect, fakeFetch(addresses({})).impl, store);

  const link = await google.signIn(owner, "  Work ");
  assert.deepEqual(link, {
    account: "work",
    added: true,
    url: "https://connect.test/authorize/work",
    expiresAt: new Date("2026-10-18T01:00:00Z"),
  });
  assert.deepEqual(store.labels(), ["personal", "work"]);
  assert.equal(started[0]?.connector, connector);
  assert.deepEqual(started[0]?.params, { subject: googleSubject(owner, "work"), scopes: [...googleScopes] });

  assert.deepEqual(await google.listAccounts(owner), [
    { account: "personal", email: "unknown@example.com", status: "connected" },
    { account: "work", email: null, status: "needs_connecting" },
  ]);
  assert.deepEqual(started[0]?.params, tokenCalls.find((call) => labelOf(call.params) === "work")?.params);
});

test("reconnecting an existing name reuses its subject, writes nothing and forgets its old address", async () => {
  const { connect, started } = fakeConnect({ personal: "token-personal" });
  let address = "old@gmail.example";
  const { impl } = fakeFetch((url) =>
    url.hostname === "openidconnect.googleapis.com" ? Response.json({ email: address }) : undefined,
  );
  const store = fakeAccountStore(["personal"]);
  let writes = 0;
  const counting: GoogleAccountStore = { read: () => store.read(), write: (...args) => (writes++, store.write(...args)) };
  const google = workspace(["personal"], connect, impl, counting);
  assert.equal((await google.listAccounts(owner))[0]?.email, "old@gmail.example");

  const link = await google.signIn(owner, "Personal");
  assert.equal(link.added, false);
  assert.equal(writes, 0);
  assert.deepEqual(started[0]?.params.subject, googleSubject(owner, "personal"));
  address = "new@gmail.example";
  assert.equal((await google.listAccounts(owner))[0]?.email, "new@gmail.example");
});

test("with a shared address cache, a reconnect on one instance is seen by the others", async () => {
  const { connect } = fakeConnect({ personal: "token-personal" });
  let address = "old@gmail.example";
  const { impl } = fakeFetch((url) =>
    url.hostname === "openidconnect.googleapis.com" ? Response.json({ email: address }) : undefined,
  );
  const store = fakeAccountStore(["personal"]);
  const addressCache = memoryCache();
  const instance = () =>
    googleWorkspace({
      connector,
      accounts: googleAccountRegistry({ store, cache: memoryCache(), cacheTtlSeconds: 60 }),
      connect,
      addressCache,
      timeZone: "Australia/Brisbane",
      fetch: impl,
    });
  const [one, two] = [instance(), instance()];
  assert.equal((await two.listAccounts(owner))[0]?.email, "old@gmail.example");
  await one.signIn(owner, "personal");
  address = "new@gmail.example";
  assert.equal((await two.listAccounts(owner))[0]?.email, "new@gmail.example");
});

test("an account can be reconnected by its address, and a bad name adds nothing", async () => {
  const { connect, started } = fakeConnect({ work: "token-work" });
  const store = fakeAccountStore(both);
  const google = workspace(both, connect, fakeFetch(addresses({ "token-work": "me@work.example" })).impl, store);
  assert.equal((await google.signIn(owner, "ME@work.example")).account, "work");
  assert.deepEqual(started[0]?.params.subject, googleSubject(owner, "work"));
  await assert.rejects(google.signIn(owner, "!!!"), /can't name an account/u);
  await assert.rejects(google.signIn(owner, "stranger@else.example"), /not one of the user's Google accounts/u);
  assert.deepEqual(store.labels(), both);
});

test("disconnecting revokes that account's grant and drops it from the list", async () => {
  const { connect, revoked } = fakeConnect({ personal: "token-personal", work: "token-work" });
  const store = fakeAccountStore(both);
  const google = workspace(both, connect, fakeFetch(addresses({ "token-work": "me@work.example" })).impl, store);
  assert.deepEqual(await google.findAccount(owner, "me@work.example"), { account: "work", email: "me@work.example" });

  assert.deepEqual(await google.disconnect(owner, "me@work.example"), {
    disconnected: true,
    account: "work",
    hadGrant: true,
  });
  assert.deepEqual(revoked, ["work"]);
  assert.deepEqual(store.labels(), ["personal"]);
  assert.deepEqual(
    (await google.listAccounts(owner)).map((account) => account.account),
    ["personal"],
  );
});

test("an account that never signed in is still removed when disconnected", async () => {
  const { connect, revoked } = fakeConnect({});
  const store = fakeAccountStore(["work"]);
  const result = await workspace(["work"], connect, fakeFetch().impl, store).disconnect(owner, "work");
  assert.deepEqual(result, { disconnected: true, account: "work", hadGrant: false });
  assert.deepEqual(revoked, []);
  assert.deepEqual(store.labels(), []);
});

test("a revoke that fails keeps the account listed so the owner can try again", async () => {
  const { connect } = fakeConnect({ work: "token-work" }, { revokeError: new ConnectError("Failed to revoke token: 503") });
  const store = fakeAccountStore(["work"]);
  const result = await workspace(["work"], connect, fakeFetch().impl, store).disconnect(owner, "work");
  assert.equal(result.disconnected, false);
  assert.match(result.disconnected ? "" : result.reason, /still connected: Failed to revoke token: 503/u);
  assert.deepEqual(store.labels(), ["work"]);
});

test("a name connected on another instance is found by going back to the store once", async () => {
  const { connect } = fakeConnect({ personal: "token-personal", work: "token-work" });
  const store = fakeAccountStore(["personal"]);
  const google = workspace(["personal"], connect, fakeFetch(oneMessage).impl, store);
  assert.deepEqual(
    (await google.listAccounts(owner)).map((account) => account.account),
    ["personal"],
  );
  const current = await store.read();
  assert.ok(current);
  await store.write([...current.accounts, { label: "work", addedAt: "2026-10-18T00:00:00.000Z" }], current);
  const found = await google.searchEmail(owner, "x", { account: "work", max: 5 });
  assert.equal(found.results[0]?.account, "work");
});

test("a Gmail 403 rate limit is retried like a 429", async () => {
  const { connect } = fakeConnect({ personal: "token" });
  let lists = 0;
  const { impl } = fakeFetch((url) => {
    if (!url.pathname.endsWith("/messages")) return undefined;
    lists += 1;
    return lists === 1
      ? Response.json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403 })
      : Response.json({ messages: [] });
  });
  const found = await workspace(personal, connect, impl).searchEmail(owner, "x", { max: 5 });
  assert.equal(lists, 2);
  assert.deepEqual(found.errors, []);
});

test("a grant missing a scope asks for the account to be connected again", async () => {
  const { connect } = fakeConnect({ personal: "token" });
  const { impl } = fakeFetch((url) =>
    url.pathname.endsWith("/messages")
      ? Response.json({ error: { message: "Request had insufficient authentication scopes." } }, { status: 403 })
      : undefined,
  );
  const found = await workspace(personal, connect, impl).searchEmail(owner, "x", { max: 5 });
  assert.equal(found.errors[0]?.needsConnecting, true);
  assert.match(found.errors[0]?.error ?? "", /without the permission this needs/u);
});

test("search reports truncated when Gmail has more matches", async () => {
  const { connect } = fakeConnect({ personal: "token" });
  const { impl } = fakeFetch(
    (url) =>
      url.pathname.endsWith("/messages")
        ? Response.json({ messages: [{ id: "m1" }], nextPageToken: "next" })
        : undefined,
    (url) => (url.pathname.endsWith("/messages/m1") ? Response.json({ id: "m1", threadId: "t1" }) : undefined),
  );
  const found = await workspace(personal, connect, impl).searchEmail(owner, "x", { max: 1 });
  assert.equal(found.results.length, 1);
  assert.equal(found.truncated, true);
});

test("events merge across calendars earliest first, and a failing shared calendar is reported", async () => {
  const { connect } = fakeConnect({ personal: "token" });
  const { impl } = fakeFetch(
    (url) =>
      url.pathname.endsWith("/calendarList")
        ? Response.json({
            items: [
              { id: "a@example.com", summary: "Me", primary: true, selected: true },
              { id: "team", summary: "Team", selected: true },
              { id: "broken", summary: "Broken", selected: true },
              { id: "hidden", summary: "Hidden", selected: false },
            ],
          })
        : undefined,
    (url) => {
      const match = /\/calendars\/([^/]+)\/events$/u.exec(url.pathname);
      if (!match?.[1]) return undefined;
      const id = decodeURIComponent(match[1]);
      if (id === "broken") return new Response("nope", { status: 404 });
      if (id === "hidden") throw new Error("hidden calendar should not be read");
      const start = id === "team" ? "2026-10-18T09:00:00+10:00" : "2026-10-18T11:00:00+10:00";
      return Response.json({
        items: [
          {
            id: `e-${id}`,
            summary: `event ${id}`,
            start: { dateTime: start },
            end: { dateTime: start },
            attendees: [{ email: "a@example.com", self: true, responseStatus: "accepted" }, { email: "b@example.com" }],
          },
          { id: "gone", status: "cancelled", start: { date: "2026-10-18" }, end: { date: "2026-10-19" } },
        ],
      });
    },
  );

  const range = { from: new Date("2026-10-18T00:00:00+10:00"), to: new Date("2026-10-19T00:00:00+10:00") };
  const found = await workspace(personal, connect, impl).listEvents(owner, range, { primaryOnly: false, max: 10 });
  assert.deepEqual(
    found.results.map((event) => [event.calendar, event.title, event.myResponse, event.attendees]),
    [
      ["Team", "event team", "accepted", ["b@example.com"]],
      ["Me", "event a@example.com", "accepted", ["b@example.com"]],
    ],
  );
  assert.equal(found.errors.length, 1);
  assert.match(found.errors[0]?.error ?? "", /calendar "Broken" was skipped/u);
});

test("events follow page tokens and flag what the bound cut off", async () => {
  const { connect } = fakeConnect({ personal: "token" });
  const pages: string[] = [];
  const event = (id: string, hour: number) => ({
    id,
    summary: id,
    start: { dateTime: `2026-10-18T${String(hour).padStart(2, "0")}:00:00+10:00` },
    end: { dateTime: `2026-10-18T${String(hour).padStart(2, "0")}:30:00+10:00` },
  });
  const { impl } = fakeFetch((url) => {
    if (!url.pathname.endsWith("/events")) return undefined;
    const token = url.searchParams.get("pageToken") ?? "first";
    pages.push(token);
    if (token === "first") return Response.json({ items: [event("one", 8)], nextPageToken: "second" });
    if (token === "second") return Response.json({ items: [], nextPageToken: "third" });
    return Response.json({ items: [event("three", 9)], nextPageToken: "fourth" });
  });

  const range = { from: new Date("2026-10-18T00:00:00+10:00"), to: new Date("2026-10-19T00:00:00+10:00") };
  const found = await workspace(personal, connect, impl).listEvents(owner, range, { primaryOnly: true, max: 10 });
  assert.deepEqual(pages, ["first", "second", "third"]);
  assert.deepEqual(
    found.results.map((e) => e.title),
    ["one", "three"],
  );
  assert.equal(found.truncated, true);
});

test("all-day events end on their last day and sort at local midnight", async () => {
  const { connect } = fakeConnect({ personal: "token" });
  const { impl } = fakeFetch((url) =>
    url.pathname.endsWith("/events")
      ? Response.json({
          items: [
            { id: "early", summary: "6am run", start: { dateTime: "2026-10-18T06:00:00+10:00" }, end: { dateTime: "2026-10-18T07:00:00+10:00" } },
            { id: "trip", summary: "trip", start: { date: "2026-10-18" }, end: { date: "2026-10-21" } },
            { id: "leave", summary: "day off", start: { date: "2026-10-18" }, end: { date: "2026-10-19" } },
          ],
        })
      : undefined,
  );
  const range = { from: new Date("2026-10-18T00:00:00+10:00"), to: new Date("2026-10-22T00:00:00+10:00") };
  const found = await workspace(personal, connect, impl).listEvents(owner, range, { primaryOnly: true, max: 10 });
  assert.deepEqual(
    found.results.map((e) => [e.title, e.end.allDay ? e.end.date : "timed"]),
    [
      ["trip", "2026-10-20"],
      ["day off", "2026-10-18"],
      ["6am run", "timed"],
    ],
  );
});

test("a mailbox watch on the inbox posts to Gmail and returns its expiry", async () => {
  const { connect } = fakeConnect({ personal: "token" });
  const { impl, calls } = fakeFetch((url) =>
    url.pathname.endsWith("/watch") ? Response.json({ historyId: "100", expiration: "1790604800000" }) : undefined,
  );
  const watch = await workspace(personal, connect, impl).watchMailbox(owner, "personal", "projects/p/topics/gmail");
  assert.deepEqual(watch, { historyId: "100", expiresAt: new Date(1790604800000) });
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    topicName: "projects/p/topics/gmail",
    labelIds: ["INBOX"],
    labelFilterBehavior: "include",
  });
});

test("mailbox history lists each added inbox message once", async () => {
  const { connect } = fakeConnect({ personal: "token" });
  const { impl, calls } = fakeFetch((url) =>
    url.pathname.endsWith("/history")
      ? Response.json({
          history: [
            { messagesAdded: [{ message: { id: "a" } }, { message: { id: "b" } }] },
            { messagesAdded: [{ message: { id: "a" } }] },
            {},
          ],
          historyId: "120",
        })
      : undefined,
  );
  const history = await workspace(personal, connect, impl).mailboxHistory(owner, "personal", "100");
  assert.deepEqual(history, { addedMessageIds: ["a", "b"], historyId: "120", nextPageToken: null });
  assert.equal(calls[0]?.url.searchParams.get("historyTypes"), "messageAdded");
  assert.equal(calls[0]?.url.searchParams.get("labelId"), "INBOX");
});
