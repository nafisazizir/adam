import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionAuthContext } from "eve/context";

import { CalendarTooLargeError, type CalendarReader } from "#lib/calendar-changes.js";
import { calendarChannelTokens } from "#lib/calendar-push.js";
import { calendarPushHandler, calendarRunHandler, type CalendarPushDeps } from "#lib/calendar-routes.js";
import { GoogleApiError, GoogleNeedsConnectingError } from "#lib/google.js";
import { memoryCache, type SharedCache } from "#lib/shared-cache.js";

const tokens = calendarChannelTokens("secret");
const pushUrl = "https://adam.test/eve/v1/calendar/push";
const owner = { issuer: "photon-imessage", principalId: "+61400000000" };

const channelEnds = new Date("2026-11-02T00:00:00Z");

function notification(
  state = "exists",
  channelId = "c1",
  token = tokens.sign("c1", { account: "work", calendarId: "primary" }, channelEnds),
) {
  return new Request(pushUrl, {
    method: "POST",
    headers: {
      "x-goog-channel-id": channelId,
      "x-goog-channel-token": token,
      "x-goog-resource-state": state,
      "x-goog-resource-id": "r1",
      "x-goog-message-number": "2",
    },
  });
}

function pushHandler(overrides: Partial<CalendarPushDeps> = {}) {
  const published: unknown[] = [];
  const cache = overrides.cache ?? memoryCache();
  const handler = calendarPushHandler({
    tokens,
    cache,
    today: () => "2026-10-26",
    now: () => new Date("2026-10-26T00:00:05Z"),
    publish: async (run) => void published.push(run),
    ...overrides,
  });
  return { handler, published, cache };
}

test("a push without Adam's channel token is refused", async () => {
  const { handler, published } = pushHandler();
  assert.equal((await handler(new Request(pushUrl, { method: "POST" }))).status, 401);
  assert.equal((await handler(notification("exists", "c2"))).status, 401);
  assert.equal((await handler(notification("exists", "c1", "account=work&calendar=primary&sig=forged"))).status, 401);
  assert.equal(published.length, 0);
});

test("a replayed token from a channel that has ended is refused", async () => {
  const { handler, published } = pushHandler({ now: () => new Date("2026-11-02T00:00:05Z") });
  assert.equal((await handler(notification())).status, 401);
  assert.equal(published.length, 0);
});

test("the sync message that opens a channel is acknowledged without a run", async () => {
  const { handler, published } = pushHandler();
  const response = await handler(notification("sync"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ignored: "sync" });
  assert.equal(published.length, 0);
});

test("a burst of changes queues one run for the account's calendar", async () => {
  const { handler, published } = pushHandler();
  for (let i = 0; i < 3; i += 1) assert.equal((await handler(notification())).status, 200);
  assert.equal(published.length, 1);
  assert.deepEqual((published[0] as { body: unknown }).body, { account: "work", calendarId: "primary", channelId: "c1" });
});

test("a failed publish is a 500 so Google retries, and the next push publishes again", async () => {
  let fail = true;
  const published: unknown[] = [];
  const { handler } = pushHandler({
    publish: async (run) => {
      if (fail) throw new Error("qstash down");
      published.push(run);
    },
  });
  assert.equal((await handler(notification())).status, 500);
  fail = false;
  assert.equal((await handler(notification())).status, 200);
  assert.equal(published.length, 1);
});

function runRequest(body: unknown): Request {
  return new Request("https://adam.test/eve/v1/calendar/process", {
    method: "POST",
    headers: { "upstash-message-id": "msg-1" },
    body: JSON.stringify(body),
  });
}

function runHandler(options: { cache?: SharedCache; listed?: boolean; reader?: CalendarReader; signed?: boolean } = {}) {
  const delivered: { message: string; auth: SessionAuthContext }[] = [];
  const handler = calendarRunHandler({
    cache: options.cache ?? memoryCache(),
    timeContext: () => "<current_time>now</current_time>",
    verify: async () => options.signed ?? true,
    isListed: async () => options.listed ?? true,
    ownerAddresses: async () => ["me@work.example"],
    reader: () =>
      options.reader ?? {
        changes: async () => ({ revisions: [], nextSyncToken: "s1", nextPageToken: null }),
      },
  });
  const home = async () => ({
    owner,
    deliver: async (message: string, auth: SessionAuthContext) => void delivered.push({ message, auth }),
  });
  return { handler: (request: Request) => handler(request, home), delivered };
}

const body = { account: "work", calendarId: "primary", channelId: "c1" };

test("a run without a QStash signature, or with a malformed body, is refused", async () => {
  assert.equal((await runHandler({ signed: false }).handler(runRequest(body))).status, 401);
  assert.equal((await runHandler().handler(runRequest({ account: "work" }))).status, 400);
});

test("a run for an account no longer connected silences its channel's later pushes", async () => {
  const cache = memoryCache();
  const response = await runHandler({ cache, listed: false }).handler(runRequest(body));
  assert.deepEqual(await response.json(), { ok: true, ignored: "unlisted" });

  const { handler, published } = pushHandler({ cache });
  assert.deepEqual(await (await handler(notification())).json(), { ok: true, ignored: "stale_channel" });
  assert.equal(published.length, 0);
});

test("an account that needs connecting is acknowledged and never signed in", async () => {
  const reader: CalendarReader = {
    changes: async () => {
      throw new GoogleNeedsConnectingError("work", "is not connected");
    },
  };
  const response = await runHandler({ reader }).handler(runRequest(body));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ignored: "needs_connecting" });
});

test("a failure that every retry would repeat is acknowledged, a passing one is retried", async () => {
  const failing = (error: Error): CalendarReader => ({
    changes: async () => {
      throw error;
    },
  });
  const tooBig = await runHandler({ reader: failing(new CalendarTooLargeError("too many")) }).handler(runRequest(body));
  assert.deepEqual(await tooBig.json(), { ok: true, ignored: "permanent_failure" });
  const notFound = await runHandler({ reader: failing(new GoogleApiError("gone", 404)) }).handler(runRequest(body));
  assert.equal(notFound.status, 200);
  const limited = await runHandler({ reader: failing(new GoogleApiError("slow down", 429)) }).handler(runRequest(body));
  assert.equal(limited.status, 500);
  const outage = await runHandler({ reader: failing(new Error("socket hang up")) }).handler(runRequest(body));
  assert.equal(outage.status, 500);
});

test("a change someone else made reaches the home thread as the owner, under the calendar authenticator", async () => {
  const cache = memoryCache();
  let syncs = 0;
  const reader: CalendarReader = {
    async changes(cursor) {
      syncs += 1;
      if (!cursor.syncToken) return { revisions: [], nextSyncToken: "s1", nextPageToken: null };
      const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
      return {
        nextSyncToken: "s2",
        nextPageToken: null,
        revisions: [
          {
            id: "e1",
            updated: "u1",
            cancelled: false,
            ordinary: true,
            organizedByOwner: false,
            organizer: "sam@corp.example",
            recurring: false,
            seriesUntil: null,
            instanceOf: null,
            originalStart: null,
            declinedBy: [],
            event: {
              account: "work",
              calendar: "work",
              calendarId: "primary",
              id: "e1",
              title: "Offsite planning",
              start: { allDay: false, at: start },
              end: { allDay: false, at: new Date(start.getTime() + 60 * 60 * 1000) },
              location: "",
              description: "",
              organizer: "Sam <sam@corp.example>",
              attendees: [],
              myResponse: "needsAction",
              link: null,
              meetLink: null,
            },
          },
        ],
      };
    },
  };
  const { handler, delivered } = runHandler({ cache, reader });
  assert.deepEqual(await (await handler(runRequest(body))).json(), { ok: true, kind: "started" });
  assert.deepEqual(await (await handler(runRequest(body))).json(), { ok: true, kind: "delivered", count: 1 });
  assert.equal(syncs, 2);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]?.message ?? "", /<calendar_change account="work">/u);
  assert.match(delivered[0]?.message ?? "", /New invitation/u);
  assert.equal(delivered[0]?.auth.authenticator, "calendar");
  assert.equal(delivered[0]?.auth.principalId, owner.principalId);
});
