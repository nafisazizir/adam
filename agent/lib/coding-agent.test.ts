import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { CodingAgentError, type CodingSession, type CreateCodingSession } from "#lib/coding-agent.js";
import {
  archiveCodingSession,
  codingAgent,
  codingProviderDefault,
  codingProviderFor,
  createCodingSession,
  getCodingSession,
  listKnownCodingSessions,
} from "#lib/coding-agents.js";
import { codingSessionState, codingUpdateFor, codingUpdateMessage, watchTickSchema } from "#lib/coding-sessions.js";
import { cursorAgentId, createCursorCodingAgent } from "#lib/cursor.js";
import { DevinApiError, createDevinCodingAgent } from "#lib/devin.js";
import { env } from "#lib/env.js";
import { finishedUpdate } from "#evals/coding/updates.js";

interface Hit {
  readonly method: string;
  readonly href: string;
  readonly host: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly body: unknown;
  readonly authorization: string | null;
  readonly contentType: string | null;
}

function recordedFetch(routes: (hit: Hit) => { status?: number; json: unknown }) {
  const hits: Hit[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const hit: Hit = {
      method: init?.method ?? "GET",
      href: url.href,
      host: url.host,
      path: url.pathname,
      search: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init?.headers).get("authorization"),
      contentType: new Headers(init?.headers).get("content-type"),
    };
    hits.push(hit);
    const result = routes(hit);
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, hits };
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function devinSession(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "devin-1",
    url: "https://app.devin.ai/sessions/devin-1",
    title: "Add calendar",
    status: "running",
    status_detail: "finished",
    is_archived: false,
    tags: ["adam", "adam-request-turn_1"],
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    pull_requests: [{ pr_url: "https://github.com/acme/app/pull/4", pr_state: "open" }],
    ...overrides,
  };
}

function page(items: unknown[], more?: { cursor: string }) {
  return { items, has_next_page: Boolean(more), end_cursor: more?.cursor ?? null };
}

const devinInput: CreateCodingSession = {
  prompt: "Ship the calendar tool.",
  title: "Add calendar",
  repos: ["acme/app"],
  idempotencyKey: "turn/1",
};

test("the default provider prefers devin unless cursor is the only one configured", () => {
  assert.equal(codingProviderDefault(undefined, ["devin", "cursor"]), "devin");
  assert.equal(codingProviderDefault(undefined, ["devin"]), "devin");
  assert.equal(codingProviderDefault(undefined, []), "devin");
  assert.equal(codingProviderDefault(undefined, ["cursor"]), "cursor");
  assert.equal(codingProviderDefault("cursor", ["devin"]), "cursor");
  assert.equal(codingAgent().name, "devin");
});

test("a session id routes to its provider, and an explicit provider wins", () => {
  assert.equal(codingProviderFor("devin-1"), "devin");
  assert.equal(codingProviderFor("bc-00000000-0000-0000-0000-000000000001"), "cursor");
  assert.equal(codingProviderFor("bc-00000000-0000-0000-0000-000000000001", "devin"), "devin");
});

test("devin create posts the brief, tags and repos, and a replay returns the tagged session", async () => {
  let lookups = 0;
  const seen = recordedFetch((hit) => {
    if (hit.method === "GET") {
      lookups += 1;
      const replay = hit.search.get("tags") === "adam-request-turn_1" && lookups > 1;
      return { json: page(replay ? [devinSession()] : []) };
    }
    return { json: devinSession({ session_id: "devin-new", tags: ["adam", "adam-request-turn_1"] }) };
  });
  const agent = createDevinCodingAgent({
    fetch: seen.fetchImpl,
    apiKey: "cog_test",
    orgId: "org-test",
    maxAcuLimit: 4,
  });

  const created = await agent.createSession(devinInput);
  assert.equal(created.id, "devin-new");
  assert.equal(created.provider, "devin");
  assert.deepEqual(created.branches, []);
  assert.equal(created.createdAt.toISOString(), new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(created.pullRequests, [{ url: "https://github.com/acme/app/pull/4", state: "open" }]);

  const post = seen.hits.find((hit) => hit.method === "POST");
  assert.ok(post);
  assert.equal(post.host, "api.devin.ai");
  assert.equal(post.path, "/v3/organizations/org-test/sessions");
  assert.equal(post.authorization, "Bearer cog_test");
  assert.equal(post.contentType, "application/json");
  assert.deepEqual(post.body, {
    prompt: devinInput.prompt,
    title: devinInput.title,
    tags: ["adam", "adam-request-turn_1"],
    repos: ["acme/app"],
    max_acu_limit: 4,
  });
  assert.equal(seen.hits[0]?.search.get("tags"), "adam-request-turn_1");

  seen.hits.length = 0;
  const again = await agent.createSession(devinInput);
  assert.equal(again.id, "devin-1");
  assert.equal(seen.hits.some((hit) => hit.method === "POST"), false);
});

test("devin drops sessions the tag filter failed to exclude, and keeps its own", async () => {
  const older = devinSession({
    session_id: "devin-old",
    updated_at: 1_600_000_000_000,
    tags: ["adam"],
  });
  const newer = devinSession({ session_id: "devin-new", updated_at: 1_800_000_000_000, tags: ["adam"] });
  const stranger = devinSession({ session_id: "devin-stranger", tags: ["other"] });
  const seen = recordedFetch(() => ({ json: page([stranger, older, newer]) }));
  const sessions = await createDevinCodingAgent({
    fetch: seen.fetchImpl,
    apiKey: "cog_test",
    orgId: "org-test",
  }).listSessions(2);

  assert.deepEqual(sessions.map((session) => session.id), ["devin-new", "devin-old"]);
  assert.equal(seen.hits[0]?.search.get("tags"), "adam");
  assert.equal(seen.hits[0]?.search.get("first"), "2");
  assert.equal(sessions[1]?.updatedAt.toISOString(), new Date(1_600_000_000_000).toISOString());
});

test("devin messages page through, and a devin event is the agent's", async () => {
  const seen = recordedFetch((hit) => {
    if (hit.search.get("after") === "cursor-1") {
      return {
        json: page([{ event_id: "e2", source: "user", message: "ship it", created_at: 1_700_000_200 }]),
      };
    }
    return {
      json: page(
        [{ event_id: "e1", source: "devin", message: "done", created_at: 1_700_000_050 }],
        { cursor: "cursor-1" },
      ),
    };
  });
  const messages = await createDevinCodingAgent({
    fetch: seen.fetchImpl,
    apiKey: "cog_test",
    orgId: "org-test",
  }).listMessages("devin-1");

  assert.deepEqual(messages.map((message) => message.from), ["agent", "user"]);
  assert.equal(messages[0]?.text, "done");
  assert.equal(seen.hits[0]?.path, "/v3/organizations/org-test/sessions/devin-1/messages");
  assert.equal(seen.hits[0]?.search.get("first"), "200");
  assert.equal(seen.hits[1]?.search.get("after"), "cursor-1");
});

test("devin follow-up, archive and repos keep their paths, and a 404 is permanent", async () => {
  const seen = recordedFetch((hit) => {
    if (hit.path.endsWith("/repositories")) {
      return {
        json: page([
          { repo_full_name: "acme/app", repo_description: "The app", repo_language: "TypeScript" },
        ]),
      };
    }
    if (hit.method === "GET" && hit.path.endsWith("/devin-missing")) {
      return { status: 404, json: { error: "missing" } };
    }
    return { json: devinSession({ is_archived: hit.path.endsWith("/archive") }) };
  });
  const agent = createDevinCodingAgent({ fetch: seen.fetchImpl, apiKey: "cog_test", orgId: "org-test" });

  await agent.sendMessage("devin-1", "merge it");
  const message = seen.hits.at(-1);
  assert.equal(message?.method, "POST");
  assert.equal(message?.path, "/v3/organizations/org-test/sessions/devin-1/messages");
  assert.deepEqual(message?.body, { message: "merge it" });

  const stopped = await agent.stopSession("devin-1");
  assert.equal(stopped.archived, true);
  assert.equal(seen.hits.at(-1)?.path, "/v3/organizations/org-test/sessions/devin-1/archive");

  const repos = await agent.listRepos("app", 5);
  assert.deepEqual(repos, [{ name: "acme/app", description: "The app", language: "TypeScript" }]);
  assert.equal(seen.hits.at(-1)?.search.get("filter_name"), "app");

  await assert.rejects(agent.getSession("devin-missing"), (error: unknown) => {
    assert.ok(error instanceof DevinApiError);
    assert.ok(error instanceof CodingAgentError);
    assert.equal(error.isPermanent, true);
    assert.match(error.message, /GET \/sessions\/devin-missing failed with 404/);
    return true;
  });

  const limited = recordedFetch(() => ({ status: 429, json: { error: "slow down" } }));
  await assert.rejects(
    createDevinCodingAgent({ fetch: limited.fetchImpl, apiKey: "cog_test", orgId: "org-test" }).getSession("devin-1"),
    (error: unknown) => {
      assert.ok(error instanceof DevinApiError);
      assert.equal(error.isPermanent, false);
      return true;
    },
  );
});

test("devin without credentials fails before any request", async () => {
  const seen = recordedFetch(() => ({ json: {} }));
  await assert.rejects(
    createDevinCodingAgent({ fetch: seen.fetchImpl, apiKey: null, orgId: null }).listSessions(1),
    /set DEVIN_API_KEY and DEVIN_ORG_ID/,
  );
  assert.equal(seen.hits.length, 0);
});

function cursorAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "bc-00000000-0000-0000-0000-000000000001",
    name: "adam: Add a README",
    status: "IDLE",
    url: "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001",
    createdAt: "2026-04-13T18:30:00.000Z",
    updatedAt: "2026-04-13T18:45:00.000Z",
    latestRunId: "run-1",
    ...overrides,
  };
}

function cursorRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: "FINISHED",
    createdAt: "2026-04-13T18:30:00.000Z",
    updatedAt: "2026-04-13T18:45:00.000Z",
    result: "Added the README.",
    git: {
      branches: [
        {
          repoUrl: "github.com/acme/app",
          branch: "cursor/add-readme",
          prUrl: "https://github.com/acme/app/pull/9",
        },
      ],
    },
    ...overrides,
  };
}

function cursorClient(routes: (hit: Hit) => { status?: number; json: unknown }, model?: string | null) {
  const seen = recordedFetch(routes);
  const agent = createCursorCodingAgent({ fetch: seen.fetchImpl, apiKey: "cursor_test", model });
  return { seen, agent };
}

test("a cursor agent id is a stable bc- uuid", () => {
  const id = cursorAgentId("turn/1");
  assert.equal(id, cursorAgentId("turn/1"));
  assert.notEqual(id, cursorAgentId("turn/2"));
  assert.match(id, /^bc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test("cursor create launches the named repos and a lost response resolves by agent id", async () => {
  const id = cursorAgentId(devinInput.idempotencyKey);
  let posts = 0;
  const { seen, agent } = cursorClient((hit) => {
    if (hit.method === "POST") {
      posts += 1;
      if (posts === 1) return { status: 409, json: { code: "agent_id_conflict" } };
      return { json: { agent: cursorAgent({ id, name: hit.body && (hit.body as { name: string }).name }), run: cursorRun() } };
    }
    if (hit.path.endsWith("/runs/run-1")) return { json: cursorRun() };
    if (posts === 0) return { status: 404, json: { error: "missing" } };
    return { json: cursorAgent({ id, name: "adam: Add calendar" }) };
  });

  const created = await agent.createSession({ ...devinInput, title: "Add calendar", repos: ["acme/app", "acme/web"] });
  assert.equal(created.id, id);
  assert.equal(created.provider, "cursor");
  assert.equal(created.title, "Add calendar");
  assert.equal(codingSessionState(created), "finished");
  assert.deepEqual(created.pullRequests, [{ url: "https://github.com/acme/app/pull/9", state: null }]);
  assert.deepEqual(created.branches, [{ repo: "acme/app", branch: "cursor/add-readme" }]);
  assert.equal(posts, 1);

  const post = seen.hits.find((hit) => hit.method === "POST");
  assert.equal(post?.path, "/v1/agents");
  assert.equal(post?.authorization, "Bearer cursor_test");
  assert.deepEqual(post?.body, {
    agentId: id,
    prompt: { text: devinInput.prompt },
    name: "adam: Add calendar",
    autoCreatePR: true,
    repos: [
      { url: "https://github.com/acme/app" },
      { url: "https://github.com/acme/web" },
    ],
  });
});

test("cursor create returns an agent that already exists, and can pin a model", async () => {
  const id = cursorAgentId("same");
  const { seen, agent } = cursorClient((hit) => {
    if (hit.path.endsWith("/runs/run-1")) return { json: cursorRun({ status: "RUNNING", result: null, git: null }) };
    return { json: cursorAgent({ id, status: "ACTIVE" }) };
  }, "composer-2");

  const session = await agent.createSession({ ...devinInput, idempotencyKey: "same", repos: [] });
  assert.equal(session.id, id);
  assert.equal(codingSessionState(session), "working");
  assert.equal(seen.hits.some((hit) => hit.method === "POST"), false);

  const launched = cursorClient((hit) => {
    if (hit.method === "POST") {
      return {
        json: {
          agent: cursorAgent({ id: (hit.body as { agentId: string }).agentId, name: "adam: Add calendar" }),
          run: cursorRun({ status: "CREATING", result: null, git: null }),
        },
      };
    }
    return { status: 404, json: { error: "missing" } };
  }, "composer-2");
  await launched.agent.createSession({ ...devinInput, idempotencyKey: "fresh", repos: [] });
  const body = launched.seen.hits.find((hit) => hit.method === "POST")?.body as {
    model?: { id: string };
    repos?: unknown;
  };
  assert.deepEqual(body.model, { id: "composer-2" });
  assert.equal(body.repos, undefined);
});

test("cursor status, pull request and branch come from the latest run", async () => {
  const cases: [string, string, ReturnType<typeof codingSessionState>][] = [
    ["CREATING", "ACTIVE", "starting"],
    ["RUNNING", "ACTIVE", "working"],
    ["WAITING_FOR_BACKGROUND_WORK", "ACTIVE", "working"],
    ["FINISHED", "IDLE", "finished"],
    ["ERROR", "IDLE", "failed"],
    ["CANCELLED", "IDLE", "asleep"],
    ["EXPIRED", "IDLE", "ended"],
    ["FINISHED", "ARCHIVED", "stopped"],
  ];

  for (const [runStatus, agentStatus, state] of cases) {
    const { agent } = cursorClient((hit) => {
      if (hit.path.includes("/runs/")) {
        return {
          json: cursorRun({
            status: runStatus,
            result: runStatus === "ERROR" ? null : "done",
            error: runStatus === "ERROR" ? { message: "disk full" } : undefined,
            git: runStatus === "FINISHED" ? cursorRun().git : { branches: [] },
          }),
        };
      }
      return { json: cursorAgent({ status: agentStatus }) };
    });
    const session = await agent.getSession("bc-00000000-0000-0000-0000-000000000001");
    assert.equal(codingSessionState(session), state, runStatus);
    if (runStatus === "ERROR") assert.equal(session.statusDetail, "disk full");
    if (runStatus === "FINISHED" && agentStatus !== "ARCHIVED") {
      assert.equal(session.pullRequests[0]?.url, "https://github.com/acme/app/pull/9");
      assert.equal(session.branches[0]?.branch, "cursor/add-readme");
    }
    if (agentStatus === "ARCHIVED") {
      assert.equal(session.archived, true);
      assert.equal(session.pullRequests[0]?.url, "https://github.com/acme/app/pull/9");
    }
  }
});

test("cursor lists only its own agents, follows up, steers a busy one, and stops", async () => {
  const adam = cursorAgent();
  const { seen, agent } = cursorClient((hit) => {
    if (hit.path === "/v1/agents" && hit.search.get("cursor") === "next") {
      return {
        json: {
          items: [
            cursorAgent({
              id: "bc-2",
              name: "adam: Older",
              latestRunId: "run-2",
              updatedAt: "2026-04-13T18:00:00.000Z",
            }),
          ],
        },
      };
    }
    if (hit.path === "/v1/agents") {
      return {
        json: {
          items: [cursorAgent({ name: "someone else's agent" }), adam],
          nextCursor: "next",
        },
      };
    }
    if (hit.path.endsWith("/runs/run-2")) return { json: cursorRun({ id: "run-2", status: "FINISHED" }) };
    if (hit.path.endsWith("/runs/run-1")) return { json: cursorRun() };
    return { status: 500, json: { error: hit.path } };
  });

  const sessions = await agent.listSessions(5);
  assert.deepEqual(sessions.map((session) => session.id), [adam.id, "bc-2"]);
  assert.equal(seen.hits.some((hit) => hit.path.includes("someone")), false);
  assert.equal(seen.hits.filter((hit) => hit.path.includes("/runs/")).length, 2);

  const follow = cursorClient((hit) => {
    if (hit.method === "POST" && hit.path.endsWith("/runs")) {
      if (!(hit.body as { delivery?: string }).delivery) return { status: 409, json: { code: "agent_busy" } };
      return { status: 202, json: { delivery: "steered", runId: "run-1" } };
    }
    if (hit.path.endsWith("/unarchive")) return { json: { id: adam.id } };
    if (hit.path.endsWith("/runs/run-1")) return { json: cursorRun({ status: "RUNNING" }) };
    return { json: cursorAgent({ status: "ARCHIVED" }) };
  });
  await follow.agent.sendMessage(adam.id, "also cover the error path");
  const posts = follow.seen.hits.filter((hit) => hit.method === "POST");
  assert.equal(posts[0]?.path.endsWith("/unarchive"), true);
  assert.deepEqual(posts[1]?.body, { prompt: { text: "also cover the error path" } });
  assert.deepEqual(posts[2]?.body, {
    prompt: { text: "also cover the error path" },
    delivery: "steer",
  });

  let archived = false;
  const stopping = cursorClient((hit) => {
    if (hit.method === "POST" && hit.path.endsWith("/archive")) {
      archived = true;
      return { json: { id: adam.id } };
    }
    if (hit.method === "POST") return { json: { id: "run-1" } };
    if (hit.path.includes("/runs/")) return { json: cursorRun({ status: archived ? "CANCELLED" : "RUNNING" }) };
    return { json: cursorAgent({ status: archived ? "ARCHIVED" : "ACTIVE" }) };
  });
  const stopped = await stopping.agent.stopSession(adam.id);
  assert.equal(codingSessionState(stopped), "stopped");
  const stopPosts = stopping.seen.hits.filter((hit) => hit.method === "POST").map((hit) => hit.path);
  assert.deepEqual(stopPosts.map((path) => path.split("/").at(-1)), ["cancel", "archive"]);

  const idle = cursorClient((hit) => {
    if (hit.method === "POST") return { json: { id: adam.id } };
    if (hit.path.includes("/runs/")) return { json: cursorRun({ status: "FINISHED" }) };
    return { json: cursorAgent({ status: hit.path.endsWith("/archive") ? "IDLE" : "ARCHIVED" }) };
  });
  await idle.agent.stopSession(adam.id);
  assert.equal(idle.seen.hits.some((hit) => hit.path.endsWith("/cancel")), false);
  assert.equal(idle.seen.hits.some((hit) => hit.method === "POST" && hit.path.endsWith("/archive")), true);
});

test("cursor run results are the message list, and repos filter by name", async () => {
  const { agent } = cursorClient((hit) => {
    if (hit.path === "/v1/repositories") {
      return {
        json: {
          items: [
            { url: "https://github.com/acme/app" },
            { url: "https://github.com/acme/web" },
            { url: "https://gitlab.example.com/acme/other" },
          ],
        },
      };
    }
    if (hit.search.get("cursor") === "next") {
      return { json: { items: [cursorRun({ id: "run-1", updatedAt: "2026-04-13T18:40:00.000Z", result: "first" })] } };
    }
    return {
      json: {
        items: [
          cursorRun({ id: "run-2", updatedAt: "2026-04-13T18:50:00.000Z", status: "ERROR", result: null, error: "nope", git: null }),
          cursorRun({ id: "run-3", status: "RUNNING", result: null, git: null }),
        ],
        nextCursor: "next",
      },
    };
  });

  const messages = await agent.listMessages("bc-1");
  assert.deepEqual(messages.map((message) => [message.id, message.text, message.from]), [
    ["run-1", "first", "agent"],
    ["run-2", "nope", "agent"],
  ]);

  const repos = await agent.listRepos("APP", 1);
  assert.deepEqual(repos, [{ name: "acme/app", description: null, language: null }]);
});

test("cursor without a key fails before any request, and a 500 can be retried", async () => {
  const missing = recordedFetch(() => ({ json: {} }));
  await assert.rejects(
    createCursorCodingAgent({ fetch: missing.fetchImpl, apiKey: null }).getSession("bc-1"),
    /set CURSOR_API_KEY/,
  );
  assert.equal(missing.hits.length, 0);

  const failed = recordedFetch(() => ({ status: 500, json: { error: "down" } }));
  await assert.rejects(
    createCursorCodingAgent({ fetch: failed.fetchImpl, apiKey: "cursor_test" }).getSession("bc-1"),
    (error: unknown) => {
      assert.ok(error instanceof CodingAgentError);
      assert.equal(error.provider, "cursor");
      assert.equal(error.isPermanent, false);
      assert.match(error.message, /GET \/agents\/bc-1 failed with 500/);
      return true;
    },
  );
});

test("the factory dispatches create, get and stop by provider name", async () => {
  const id = cursorAgentId("factory");
  let cursorCreated = false;
  const seen = recordedFetch((hit) => {
    if (hit.host === "api.cursor.com") {
      if (hit.method === "POST" && hit.path === "/v1/agents") {
        cursorCreated = true;
        return {
          json: {
            agent: cursorAgent({ id, name: "adam: Thing" }),
            run: cursorRun({ status: "CREATING", git: null, result: null }),
          },
        };
      }
      if (hit.path.includes("/runs/")) return { json: cursorRun() };
      if (hit.method === "GET" && hit.path.endsWith(`/${id}`) && !cursorCreated) {
        return { status: 404, json: { error: "missing" } };
      }
      if (hit.method === "POST") return { json: { id } };
      return { json: cursorAgent() };
    }
    if (hit.method === "POST") return { json: devinSession({ session_id: "devin-new" }) };
    if (hit.path.endsWith("/sessions")) return { json: page([]) };
    return { json: devinSession() };
  });
  globalThis.fetch = seen.fetchImpl;

  const cursorSession = await createCodingSession(
    { prompt: "go", title: "Thing", repos: ["acme/app"], idempotencyKey: "factory" },
    "cursor",
  );
  assert.equal(cursorSession.provider, "cursor");
  assert.equal(cursorSession.id, id);
  assert.equal(seen.hits.some((hit) => hit.host === "api.cursor.com" && hit.method === "POST"), true);
  assert.equal(
    seen.hits.find((hit) => hit.host === "api.cursor.com")?.authorization,
    `Bearer ${env.CURSOR_API_KEY}`,
  );

  seen.hits.length = 0;
  const devinSessionResult = await codingAgent("devin").createSession(devinInput);
  assert.equal(devinSessionResult.provider, "devin");
  assert.equal(seen.hits.every((hit) => hit.host === "api.devin.ai"), true);
  assert.equal(seen.hits.find((hit) => hit.method === "POST")?.authorization, `Bearer ${env.DEVIN_API_KEY}`);

  seen.hits.length = 0;
  await getCodingSession("bc-00000000-0000-0000-0000-000000000001");
  assert.equal(seen.hits[0]?.host, "api.cursor.com");

  seen.hits.length = 0;
  await getCodingSession("devin-1");
  assert.equal(seen.hits[0]?.host, "api.devin.ai");

  seen.hits.length = 0;
  await archiveCodingSession("bc-00000000-0000-0000-0000-000000000001", "devin");
  assert.equal(seen.hits[0]?.host, "api.devin.ai");
});

test("listing for a merge keeps the vendor that answered when the other fails", async () => {
  const seen = recordedFetch((hit) => {
    if (hit.host === "api.cursor.com") return { status: 503, json: { error: "down" } };
    return { json: page([devinSession()]) };
  });
  globalThis.fetch = seen.fetchImpl;

  const sessions = await listKnownCodingSessions(10);
  assert.deepEqual(sessions.map((session) => session.provider), ["devin"]);

  const down = recordedFetch(() => ({ status: 503, json: { error: "down" } }));
  globalThis.fetch = down.fetchImpl;
  await assert.rejects(listKnownCodingSessions(10), /Devin API/);
});

function session(overrides: Partial<CodingSession> = {}): CodingSession {
  return {
    id: "devin-1",
    provider: "devin",
    url: "https://app.devin.ai/sessions/devin-1",
    title: "Add calendar",
    status: "running",
    statusDetail: "finished",
    archived: false,
    createdAt: new Date("2026-04-13T18:30:00.000Z"),
    updatedAt: new Date("2026-04-13T18:40:00.000Z"),
    pullRequests: [],
    branches: [],
    ...overrides,
  };
}

test("a coding update relays the agent's message, and waits out a message the agent has not read", () => {
  const now = Date.parse("2026-04-13T18:45:00.000Z");
  const agentMessage = { id: "m1", from: "agent" as const, text: "Done", at: new Date(now - 60_000) };
  const found = codingUpdateFor(session(), [agentMessage], now);
  assert.equal(found?.update.state, "finished");
  assert.equal(found?.update.latestMessage, "Done");

  const userMessage = { id: "m2", from: "user" as const, text: "ship it", at: new Date(now - 60_000) };
  assert.equal(codingUpdateFor(session(), [agentMessage, userMessage], now), null);
  assert.ok(codingUpdateFor(session(), [agentMessage, userMessage], now + 6 * 60_000));
});

test("an update names branches only when the provider reported some", () => {
  assert.equal(codingUpdateMessage(finishedUpdate).includes("Branches:"), false);
  const text = codingUpdateMessage({
    ...finishedUpdate,
    branches: [{ repo: "acme/app", branch: "cursor/add-readme" }],
  });
  assert.match(text, /Branches:\n- acme\/app cursor\/add-readme/u);
});

test("a watch tick from before providers existed still parses", () => {
  assert.equal(
    watchTickSchema.safeParse({ sessionId: "devin-1", notified: null, failures: 0, slot: 0 }).success,
    true,
  );
  const parsed = watchTickSchema.safeParse({
    sessionId: "bc-1",
    provider: "cursor",
    notified: null,
    failures: 0,
    slot: 0,
  });
  assert.equal(parsed.success && parsed.data.provider, "cursor");
  assert.equal(
    watchTickSchema.safeParse({ sessionId: "x", provider: "other", notified: null, failures: 0, slot: 0 }).success,
    false,
  );
});
