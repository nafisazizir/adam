import { z } from "zod";

import {
  CodingAgentError,
  type CodingAgentProvider,
  type CodingRepo,
  type CodingSession,
  type CodingSessionMessage,
  type CreateCodingSession,
} from "#lib/coding-agent.js";
import { env } from "#lib/env.js";

const apiBase = "https://api.devin.ai/v3/organizations";
const messagePageSize = 200;
const maxMessagePages = 10;

const adamSessionTag = "adam";

const sessionSchema = z.object({
  session_id: z.string(),
  url: z.string(),
  title: z.string().nullish(),
  status: z.string(),
  status_detail: z.string().nullish(),
  is_archived: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  created_at: z.number(),
  updated_at: z.number(),
  pull_requests: z
    .array(z.object({ pr_url: z.string(), pr_state: z.string().nullish() }))
    .default([]),
});

const messageSchema = z.object({
  event_id: z.string(),
  source: z.string(),
  message: z.string(),
  created_at: z.number(),
});

const repositorySchema = z.object({
  repo_full_name: z.string(),
  repo_description: z.string().nullish(),
  repo_language: z.string().nullish(),
});

function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    end_cursor: z.string().nullish(),
    has_next_page: z.boolean().default(false),
  });
}

export class DevinApiError extends CodingAgentError {
  constructor(message: string, status: number) {
    super("devin", message, status);
    this.name = "DevinApiError";
  }
}

export interface DevinClientOptions {
  readonly fetch?: typeof fetch;
  readonly apiKey?: string | null;
  readonly orgId?: string | null;
  readonly maxAcuLimit?: number | null;
}

// The spec types timestamps as plain integers without a unit, so accept either.
function fromTimestamp(value: number): Date {
  return new Date(value < 1e12 ? value * 1000 : value);
}

function toSession(raw: z.infer<typeof sessionSchema>): CodingSession {
  return {
    id: raw.session_id,
    provider: "devin",
    url: raw.url,
    title: raw.title ?? null,
    status: raw.status,
    statusDetail: raw.status_detail ?? null,
    archived: raw.is_archived,
    createdAt: fromTimestamp(raw.created_at),
    updatedAt: fromTimestamp(raw.updated_at),
    pullRequests: raw.pull_requests.map((pr) => ({ url: pr.pr_url, state: pr.pr_state ?? null })),
    branches: [],
  };
}

function toMessage(raw: z.infer<typeof messageSchema>): CodingSessionMessage {
  return {
    id: raw.event_id,
    from: raw.source === "devin" ? "agent" : "user",
    text: raw.message,
    at: fromTimestamp(raw.created_at),
  };
}

export function createDevinCodingAgent(options: DevinClientOptions = {}): CodingAgentProvider {
  const fetchImpl = options.fetch;

  function credentials(): { apiKey: string; orgId: string } {
    const apiKey = options.apiKey === undefined ? env.DEVIN_API_KEY : options.apiKey;
    const orgId = options.orgId === undefined ? env.DEVIN_ORG_ID : options.orgId;
    if (!apiKey || !orgId) {
      throw new Error("Devin is not configured: set DEVIN_API_KEY and DEVIN_ORG_ID.");
    }
    return { apiKey, orgId };
  }

  function acuLimit(): number | undefined {
    const limit = options.maxAcuLimit === undefined ? env.DEVIN_MAX_ACU_LIMIT : options.maxAcuLimit;
    return limit ?? undefined;
  }

  async function devinRequest<T extends z.ZodType>(
    path: string,
    schema: T,
    init: { method?: string; query?: URLSearchParams; body?: unknown } = {},
  ): Promise<z.infer<T>> {
    const { apiKey, orgId } = credentials();
    const url = new URL(`${apiBase}/${encodeURIComponent(orgId)}${path}`);
    if (init.query) url.search = init.query.toString();

    const response = await (fetchImpl ?? globalThis.fetch)(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new DevinApiError(
        `Devin API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${detail}`,
        response.status,
      );
    }

    return schema.parse(await response.json());
  }

  function sessionPath(id: string): string {
    return `/sessions/${encodeURIComponent(id)}`;
  }

  async function listTaggedSessions(tag: string, limit: number): Promise<CodingSession[]> {
    const query = new URLSearchParams({ tags: tag, first: String(limit) });
    const page = await devinRequest("/sessions", pageSchema(sessionSchema), { query });
    // The tag filter's query encoding is undocumented, so never trust it to have applied.
    return page.items.filter((raw) => raw.tags.includes(tag)).map(toSession);
  }

  return {
    name: "devin",

    // Devin has no idempotency key, so a replayed create finds the session it already made by a tag
    // unique to the request instead of starting, and paying for, a second one.
    async createSession(input: CreateCodingSession): Promise<CodingSession> {
      const requestTag = `adam-request-${input.idempotencyKey.replace(/[^\w-]/gu, "_")}`;
      const [existing] = await listTaggedSessions(requestTag, 1);
      if (existing) return existing;

      const limit = acuLimit();
      const raw = await devinRequest("/sessions", sessionSchema, {
        method: "POST",
        body: {
          prompt: input.prompt,
          title: input.title,
          tags: [adamSessionTag, requestTag],
          ...(input.repos.length ? { repos: input.repos } : {}),
          ...(limit === undefined ? {} : { max_acu_limit: limit }),
        },
      });
      return toSession(raw);
    },

    async getSession(id: string): Promise<CodingSession> {
      return toSession(await devinRequest(sessionPath(id), sessionSchema));
    },

    async listSessions(limit: number): Promise<CodingSession[]> {
      const sessions = await listTaggedSessions(adamSessionTag, limit);
      return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    },

    async listRepos(filter: string | undefined, limit: number): Promise<CodingRepo[]> {
      const query = new URLSearchParams({ first: String(limit) });
      if (filter) query.set("filter_name", filter);
      const page = await devinRequest("/repositories", pageSchema(repositorySchema), { query });
      return page.items.map((raw) => ({
        name: raw.repo_full_name,
        description: raw.repo_description ?? null,
        language: raw.repo_language ?? null,
      }));
    },

    async listMessages(id: string): Promise<CodingSessionMessage[]> {
      const messages: CodingSessionMessage[] = [];
      let after: string | null | undefined;

      for (let page = 0; page < maxMessagePages; page += 1) {
        const query = new URLSearchParams({ first: String(messagePageSize) });
        if (after) query.set("after", after);

        const result = await devinRequest(`${sessionPath(id)}/messages`, pageSchema(messageSchema), {
          query,
        });
        messages.push(...result.items.map(toMessage));
        if (!result.has_next_page || !result.end_cursor) break;
        after = result.end_cursor;
      }

      return messages.sort((a, b) => a.at.getTime() - b.at.getTime());
    },

    async sendMessage(id: string, message: string): Promise<CodingSession> {
      const raw = await devinRequest(`${sessionPath(id)}/messages`, sessionSchema, {
        method: "POST",
        body: { message },
      });
      return toSession(raw);
    },

    async stopSession(id: string): Promise<CodingSession> {
      return toSession(
        await devinRequest(`${sessionPath(id)}/archive`, sessionSchema, { method: "POST" }),
      );
    },
  };
}

export const devinCodingAgent = createDevinCodingAgent();
