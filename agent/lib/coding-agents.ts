import { cursorCodingAgent } from "#lib/cursor.js";
import { devinCodingAgent } from "#lib/devin.js";
import { env } from "#lib/env.js";
import {
  type CodingAgentProvider,
  type CodingProviderName,
  type CodingRepo,
  type CodingSession,
  type CodingSessionMessage,
  type CreateCodingSession,
  codingProviderNames,
} from "#lib/coding-agent.js";

export type { CodingProviderName, CodingSession, CodingSessionMessage, CreateCodingSession };
export { CodingAgentError, codingProviderNames } from "#lib/coding-agent.js";

const providers: Record<CodingProviderName, CodingAgentProvider> = {
  devin: devinCodingAgent,
  cursor: cursorCodingAgent,
};

export function isCodingProviderConfigured(name: CodingProviderName): boolean {
  if (name === "devin") return Boolean(env.DEVIN_API_KEY && env.DEVIN_ORG_ID);
  return Boolean(env.CURSOR_API_KEY);
}

export function configuredCodingProviders(): CodingProviderName[] {
  return codingProviderNames.filter((name) => isCodingProviderConfigured(name));
}

// An explicit choice wins. Otherwise Devin stays the default, including when both vendors are
// configured and when neither is (so the error is still Devin's). Cursor is the default only when
// it is the one vendor with credentials.
export function codingProviderDefault(
  selected: CodingProviderName | undefined,
  configured: readonly CodingProviderName[],
): CodingProviderName {
  if (selected) return selected;
  if (!configured.includes("devin") && configured.includes("cursor")) return "cursor";
  return "devin";
}

export function defaultCodingProvider(): CodingProviderName {
  return codingProviderDefault(env.CODING_AGENT_PROVIDER, configuredCodingProviders());
}

export function codingAgent(name: CodingProviderName = defaultCodingProvider()): CodingAgentProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown coding agent provider: ${name}`);
  return provider;
}

// An explicit provider wins. Otherwise a Cursor id (`bc-…`) selects Cursor and every other id
// selects Devin, including watches that were published before a provider was stored on the tick.
export function codingProviderFor(
  sessionId: string,
  explicit?: CodingProviderName,
): CodingProviderName {
  if (explicit) return explicit;
  if (sessionId.startsWith("bc-")) return "cursor";
  return "devin";
}

export function createCodingSession(
  input: CreateCodingSession,
  provider: CodingProviderName = defaultCodingProvider(),
): Promise<CodingSession> {
  return codingAgent(provider).createSession(input);
}

export function getCodingSession(id: string, provider?: CodingProviderName): Promise<CodingSession> {
  return codingAgent(codingProviderFor(id, provider)).getSession(id);
}

export function listCodingSessions(
  limit: number,
  provider: CodingProviderName = defaultCodingProvider(),
): Promise<CodingSession[]> {
  return codingAgent(provider).listSessions(limit);
}

// Merge has a pull request and no provider, so it looks through every configured vendor. One
// vendor's outage still leaves the other's sessions searchable; when every one fails, the first
// failure is the error a single-vendor deploy would already have thrown.
export async function listKnownCodingSessions(limit: number): Promise<CodingSession[]> {
  const names = configuredCodingProviders();
  if (names.length === 0) return codingAgent().listSessions(limit);

  const results = await Promise.allSettled(names.map((name) => codingAgent(name).listSessions(limit)));
  const rejected = results.find((result) => result.status === "rejected");
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[coding-agents] failed to list a provider's sessions", result.reason);
    }
  }
  const sessions = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const everyProviderFailed = results.every((result) => result.status === "rejected");
  if (sessions.length === 0 && rejected?.status === "rejected" && everyProviderFailed) {
    throw rejected.reason;
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export function listCodingRepos(
  filter: string | undefined,
  limit: number,
  provider: CodingProviderName = defaultCodingProvider(),
): Promise<CodingRepo[]> {
  return codingAgent(provider).listRepos(filter, limit);
}

export function listCodingSessionMessages(
  id: string,
  provider?: CodingProviderName,
): Promise<CodingSessionMessage[]> {
  return codingAgent(codingProviderFor(id, provider)).listMessages(id);
}

export function sendCodingSessionMessage(
  id: string,
  message: string,
  provider?: CodingProviderName,
): Promise<CodingSession> {
  return codingAgent(codingProviderFor(id, provider)).sendMessage(id, message);
}

export function archiveCodingSession(id: string, provider?: CodingProviderName): Promise<CodingSession> {
  return codingAgent(codingProviderFor(id, provider)).stopSession(id);
}
