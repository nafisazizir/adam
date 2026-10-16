import { z } from "zod";

import { env } from "#lib/env.js";

const apiBase = "https://api.devin.ai/v3/organizations";
const messagePageSize = 200;
const maxMessagePages = 10;

export const adamSessionTag = "adam";

const sessionSchema = z.object({
  session_id: z.string(),
  url: z.string(),
  title: z.string().nullish(),
  status: z.string(),
  status_detail: z.string().nullish(),
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

function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    end_cursor: z.string().nullish(),
    has_next_page: z.boolean().default(false),
  });
}

export interface CodingPullRequest {
  readonly url: string;
  readonly state: string | null;
}

export interface CodingSession {
  readonly id: string;
  readonly url: string;
  readonly title: string | null;
  readonly status: string;
  readonly statusDetail: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly pullRequests: readonly CodingPullRequest[];
}

export interface CodingSessionMessage {
  readonly id: string;
  readonly from: "devin" | "user";
  readonly text: string;
  readonly at: Date;
}

// The spec types timestamps as plain integers without a unit, so accept either.
function fromTimestamp(value: number): Date {
  return new Date(value < 1e12 ? value * 1000 : value);
}

function toSession(raw: z.infer<typeof sessionSchema>): CodingSession {
  return {
    id: raw.session_id,
    url: raw.url,
    title: raw.title ?? null,
    status: raw.status,
    statusDetail: raw.status_detail ?? null,
    createdAt: fromTimestamp(raw.created_at),
    updatedAt: fromTimestamp(raw.updated_at),
    pullRequests: raw.pull_requests.map((pr) => ({ url: pr.pr_url, state: pr.pr_state ?? null })),
  };
}

function toMessage(raw: z.infer<typeof messageSchema>): CodingSessionMessage {
  return {
    id: raw.event_id,
    from: raw.source === "devin" ? "devin" : "user",
    text: raw.message,
    at: fromTimestamp(raw.created_at),
  };
}

function credentials(): { apiKey: string; orgId: string } {
  if (!env.DEVIN_API_KEY || !env.DEVIN_ORG_ID) {
    throw new Error("Devin is not configured: set DEVIN_API_KEY and DEVIN_ORG_ID.");
  }
  return { apiKey: env.DEVIN_API_KEY, orgId: env.DEVIN_ORG_ID };
}

async function devinRequest<T extends z.ZodType>(
  path: string,
  schema: T,
  init: { method?: string; query?: URLSearchParams; body?: unknown } = {},
): Promise<z.infer<T>> {
  const { apiKey, orgId } = credentials();
  const url = new URL(`${apiBase}/${encodeURIComponent(orgId)}${path}`);
  if (init.query) url.search = init.query.toString();

  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`Devin API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${detail}`);
  }

  return schema.parse(await response.json());
}

function sessionPath(id: string): string {
  return `/sessions/${encodeURIComponent(id)}`;
}

export function isDevinConfigured(): boolean {
  return Boolean(env.DEVIN_API_KEY && env.DEVIN_ORG_ID);
}

export async function createCodingSession(input: {
  prompt: string;
  title?: string;
  repos?: readonly string[];
}): Promise<CodingSession> {
  const raw = await devinRequest("/sessions", sessionSchema, {
    method: "POST",
    body: {
      prompt: input.prompt,
      title: input.title,
      tags: [adamSessionTag],
      ...(input.repos?.length ? { repos: input.repos } : {}),
    },
  });
  return toSession(raw);
}

export async function getCodingSession(id: string): Promise<CodingSession> {
  return toSession(await devinRequest(sessionPath(id), sessionSchema));
}

export async function listCodingSessions(limit: number): Promise<CodingSession[]> {
  const query = new URLSearchParams({ tags: adamSessionTag, first: String(limit) });
  const page = await devinRequest("/sessions", pageSchema(sessionSchema), { query });
  return page.items.map(toSession).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function listCodingSessionMessages(id: string): Promise<CodingSessionMessage[]> {
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
}

export async function sendCodingSessionMessage(id: string, message: string): Promise<CodingSession> {
  const raw = await devinRequest(`${sessionPath(id)}/messages`, sessionSchema, {
    method: "POST",
    body: { message },
  });
  return toSession(raw);
}

// Archiving puts the session to sleep instead of terminating it, so a later message can still
// resume it.
export async function archiveCodingSession(id: string): Promise<CodingSession> {
  return toSession(
    await devinRequest(`${sessionPath(id)}/archive`, sessionSchema, { method: "POST" }),
  );
}
