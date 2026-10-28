import { createHash } from "node:crypto";

import { z } from "zod";

import {
  CodingAgentError,
  type CodingAgentProvider,
  type CodingBranch,
  type CodingPullRequest,
  type CodingRepo,
  type CodingSession,
  type CodingSessionMessage,
  type CreateCodingSession,
} from "#lib/coding-agent.js";
import { env } from "#lib/env.js";

const apiBase = "https://api.cursor.com/v1";
const adamNamePrefix = "adam: ";
const runPageSize = 100;
const maxPages = 10;

const activeRunStatuses: ReadonlySet<string> = new Set([
  "CREATING",
  "RUNNING",
  "WAITING_FOR_BACKGROUND_WORK",
]);

const agentSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  status: z.string(),
  url: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestRunId: z.string().nullish(),
});

const branchSchema = z.object({
  repoUrl: z.string(),
  branch: z.string().nullish(),
  prUrl: z.string().nullish(),
});

const runSchema = z.object({
  id: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  result: z.string().nullish(),
  error: z.unknown().optional(),
  git: z
    .object({
      branches: z.array(branchSchema).default([]),
    })
    .nullish(),
});

const createdSchema = z.object({
  agent: agentSchema,
  run: runSchema,
});

type CursorAgent = z.infer<typeof agentSchema>;
type CursorRun = z.infer<typeof runSchema>;

function listSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullish(),
  });
}

export interface CursorClientOptions {
  readonly fetch?: typeof fetch;
  readonly apiKey?: string | null;
  readonly model?: string | null;
}

// Cursor's idempotent create is a client-supplied agent id. The same key must mint the same id, and
// the documented shape is `bc-` plus a UUID, so the hash is stamped as a version-4 UUID.
export function cursorAgentId(idempotencyKey: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`adam-cursor:${idempotencyKey}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cursorName(title: string): string {
  return `${adamNamePrefix}${title}`.slice(0, 100);
}

function cursorTitle(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.startsWith(adamNamePrefix) ? name.slice(adamNamePrefix.length) : name;
}

function githubRepoUrl(repo: string): string {
  if (/^https?:\/\//iu.test(repo)) return repo;
  return `https://github.com/${repo}`;
}

function repoName(url: string): string {
  const withScheme = /^https?:\/\//iu.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).pathname.replace(/^\/|\/$/gu, "").replace(/\.git$/iu, "");
  } catch {
    return url;
  }
}

function errorDetail(error: unknown): string | null {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    const message = error.message.trim();
    return message || null;
  }
  return null;
}

function isActiveRun(status: string | null): boolean {
  return status !== null && activeRunStatuses.has(status);
}

// Map Cursor's agent and run onto the status vocabulary codingSessionState already understands.
function normalizedStatus(agentStatus: string, run: CursorRun | null): {
  status: string;
  statusDetail: string | null;
  archived: boolean;
} {
  if (agentStatus === "ARCHIVED") return { status: "suspended", statusDetail: null, archived: true };

  const runStatus = run?.status ?? null;
  if (runStatus === null || runStatus === "CREATING") {
    return { status: "new", statusDetail: null, archived: false };
  }
  if (isActiveRun(runStatus)) return { status: "running", statusDetail: null, archived: false };

  switch (runStatus) {
    case "FINISHED":
      return { status: "running", statusDetail: "finished", archived: false };
    case "ERROR":
      return { status: "error", statusDetail: errorDetail(run?.error) ?? "error", archived: false };
    case "CANCELLED":
      return { status: "suspended", statusDetail: "user_request", archived: false };
    case "EXPIRED":
      return { status: "exit", statusDetail: "expired", archived: false };
    default:
      return { status: "running", statusDetail: null, archived: false };
  }
}

function refs(run: CursorRun | null): {
  pullRequests: CodingPullRequest[];
  branches: CodingBranch[];
} {
  const pushed = run?.git?.branches ?? [];
  return {
    pullRequests: pushed.flatMap((branch) =>
      branch.prUrl ? [{ url: branch.prUrl, state: null }] : [],
    ),
    branches: pushed.flatMap((branch) =>
      branch.branch ? [{ repo: repoName(branch.repoUrl), branch: branch.branch }] : [],
    ),
  };
}

function toSession(agent: CursorAgent, run: CursorRun | null): CodingSession {
  const status = normalizedStatus(agent.status, run);
  const { pullRequests, branches } = refs(run);
  return {
    id: agent.id,
    provider: "cursor",
    url: agent.url || `https://cursor.com/agents/${agent.id}`,
    title: cursorTitle(agent.name),
    status: status.status,
    statusDetail: status.statusDetail,
    archived: status.archived,
    createdAt: new Date(agent.createdAt),
    updatedAt: new Date(agent.updatedAt),
    pullRequests,
    branches,
  };
}

function toMessage(run: CursorRun): CodingSessionMessage | null {
  const text = run.result?.trim() || errorDetail(run.error);
  if (!text) return null;
  return { id: run.id, from: "agent", text, at: new Date(run.updatedAt) };
}

export function createCursorCodingAgent(options: CursorClientOptions = {}): CodingAgentProvider {
  const fetchImpl = options.fetch;

  function apiKey(): string {
    const key = options.apiKey === undefined ? env.CURSOR_API_KEY : options.apiKey;
    if (!key) throw new Error("Cursor is not configured: set CURSOR_API_KEY.");
    return key;
  }

  function modelId(): string | undefined {
    const model = options.model === undefined ? env.CURSOR_MODEL : options.model;
    return model ?? undefined;
  }

  async function cursorRequest<T extends z.ZodType>(
    path: string,
    schema: T,
    init: { method?: string; query?: URLSearchParams; body?: unknown } = {},
  ): Promise<z.infer<T>> {
    const url = new URL(`${apiBase}${path}`);
    if (init.query) url.search = init.query.toString();

    const response = await (fetchImpl ?? globalThis.fetch)(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new CodingAgentError(
        "cursor",
        `Cursor API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${detail}`,
        response.status,
      );
    }

    return schema.parse(await response.json());
  }

  function agentPath(id: string): string {
    return `/agents/${encodeURIComponent(id)}`;
  }

  function runPath(id: string, runId: string): string {
    return `${agentPath(id)}/runs/${encodeURIComponent(runId)}`;
  }

  async function loadRun(id: string, runId: string | null | undefined): Promise<CursorRun | null> {
    if (!runId) return null;
    return cursorRequest(runPath(id, runId), runSchema);
  }

  async function getAgent(id: string): Promise<CursorAgent | null> {
    try {
      return await cursorRequest(agentPath(id), agentSchema);
    } catch (error) {
      if (error instanceof CodingAgentError && error.status === 404) return null;
      throw error;
    }
  }

  async function getSession(id: string): Promise<CodingSession> {
    const agent = await cursorRequest(agentPath(id), agentSchema);
    return toSession(agent, await loadRun(id, agent.latestRunId));
  }

  return {
    name: "cursor",

    async createSession(input: CreateCodingSession): Promise<CodingSession> {
      const id = cursorAgentId(input.idempotencyKey);
      const existing = await getAgent(id);
      if (existing) return toSession(existing, await loadRun(id, existing.latestRunId));

      const model = modelId();
      try {
        const created = await cursorRequest("/agents", createdSchema, {
          method: "POST",
          body: {
            agentId: id,
            prompt: { text: input.prompt },
            name: cursorName(input.title),
            autoCreatePR: true,
            ...(model ? { model: { id: model } } : {}),
            ...(input.repos.length
              ? { repos: input.repos.map((repo) => ({ url: githubRepoUrl(repo) })) }
              : {}),
          },
        });
        return toSession(created.agent, created.run);
      } catch (error) {
        // A replay whose first response was lost hits the id it already created. Any other 409
        // still has no agent under that id, so the original error is the one to surface.
        if (error instanceof CodingAgentError && error.status === 409) {
          const found = await getAgent(id);
          if (found) return toSession(found, await loadRun(id, found.latestRunId));
        }
        throw error;
      }
    },

    getSession,

    // List rows carry no tags or metadata, so the name prefix is what marks an agent as Adam's.
    async listSessions(limit: number): Promise<CodingSession[]> {
      const sessions: CodingSession[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < maxPages && sessions.length < limit; page += 1) {
        const query = new URLSearchParams({ limit: String(runPageSize) });
        if (cursor) query.set("cursor", cursor);
        const result = await cursorRequest("/agents", listSchema(agentSchema), { query });

        for (const item of result.items) {
          if (!item.name?.startsWith(adamNamePrefix)) continue;
          sessions.push(toSession(item, await loadRun(item.id, item.latestRunId)));
          if (sessions.length >= limit) break;
        }

        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }

      return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    },

    async listRepos(filter: string | undefined, limit: number): Promise<CodingRepo[]> {
      const result = await cursorRequest(
        "/repositories",
        z.object({ items: z.array(z.object({ url: z.string() })) }),
      );
      const needle = filter?.toLowerCase();
      return result.items
        .map((item) => ({ name: repoName(item.url), description: null, language: null }))
        .filter((repo) => repo.name && (!needle || repo.name.toLowerCase().includes(needle)))
        .slice(0, limit);
    },

    async listMessages(id: string): Promise<CodingSessionMessage[]> {
      const runs: CursorRun[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < maxPages; page += 1) {
        const query = new URLSearchParams({ limit: String(runPageSize) });
        if (cursor) query.set("cursor", cursor);
        const result = await cursorRequest(`${agentPath(id)}/runs`, listSchema(runSchema), { query });
        runs.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }

      return runs
        .flatMap((run) => {
          const message = toMessage(run);
          return message ? [message] : [];
        })
        .sort((a, b) => a.at.getTime() - b.at.getTime());
    },

    async sendMessage(id: string, message: string): Promise<CodingSession> {
      const agent = await cursorRequest(agentPath(id), agentSchema);
      if (agent.status === "ARCHIVED") {
        await cursorRequest(`${agentPath(id)}/unarchive`, z.object({ id: z.string() }), { method: "POST" });
      }

      const body = { prompt: { text: message } };
      try {
        await cursorRequest(`${agentPath(id)}/runs`, z.unknown(), { method: "POST", body });
      } catch (error) {
        // One run at a time. A steer delivers the prompt into the run that is already going.
        if (!(error instanceof CodingAgentError) || error.status !== 409) throw error;
        await cursorRequest(`${agentPath(id)}/runs`, z.unknown(), {
          method: "POST",
          body: { ...body, delivery: "steer" },
        });
      }

      return getSession(id);
    },

    async stopSession(id: string): Promise<CodingSession> {
      const agent = await cursorRequest(agentPath(id), agentSchema);
      if (agent.latestRunId) {
        const run = await cursorRequest(runPath(id, agent.latestRunId), runSchema);
        if (isActiveRun(run.status)) {
          try {
            await cursorRequest(`${runPath(id, run.id)}/cancel`, z.object({ id: z.string() }), {
              method: "POST",
            });
          } catch (error) {
            if (!(error instanceof CodingAgentError) || error.status !== 409) throw error;
          }
        }
      }

      await cursorRequest(`${agentPath(id)}/archive`, z.object({ id: z.string() }), { method: "POST" });
      return getSession(id);
    },
  };
}

export const cursorCodingAgent = createCursorCodingAgent();
