import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

import type { CodingSession, CodingSessionMessage } from "#lib/devin.js";
import { env } from "#lib/env.js";
import type { HomeOwner } from "#lib/home-target.js";
import { ownerAuth } from "#lib/owner.js";
import { publishCallback } from "#lib/qstash.js";
import { currentTimeContext, formatUserDateTime } from "#lib/time.js";

export type CodingSessionState =
  | "starting"
  | "working"
  | "needs_input"
  | "needs_approval"
  | "finished"
  | "asleep"
  | "stopped"
  | "halted"
  | "failed"
  | "ended";

const sleepReasons: ReadonlySet<string> = new Set(["inactivity", "user_request"]);

export function codingSessionState(session: CodingSession): CodingSessionState {
  switch (session.status) {
    case "new":
    case "claimed":
    case "resuming":
      return "starting";
    case "running":
      if (session.statusDetail === "waiting_for_user") return "needs_input";
      if (session.statusDetail === "waiting_for_approval") return "needs_approval";
      if (session.statusDetail === "finished") return "finished";
      return "working";
    case "suspended":
      if (session.archived) return "stopped";
      if (session.statusDetail === "error") return "failed";
      return session.statusDetail && !sleepReasons.has(session.statusDetail) ? "halted" : "asleep";
    case "exit":
      return "ended";
    case "error":
      return "failed";
    default:
      return "working";
  }
}

export function codingBrief(brief: string, repos: readonly string[]): string {
  return [
    brief.trim(),
    "",
    "---",
    "You were started by Adam, the owner's personal agent, on the owner's behalf. The brief above is Adam's account of what the owner asked for in chat.",
    repos.length
      ? `Start with ${repos.join(", ")}, and bring in any other repository the work needs.`
      : "Work out which repositories this needs from the brief.",
    env.selfRepo ? `Adam's own code lives in ${env.selfRepo}.` : null,
    "- Open a pull request with your change, one per repository you change. Do not merge them; the owner reviews and decides.",
    "- If you need a decision only the owner can make, ask one clear question and wait. It is relayed to them by text message, so keep it short and self-contained.",
    "- When you finish, end with a short summary: what changed, how you verified it, and anything the owner must do by hand, such as environment variables to set or settings to change.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function describeCodingSession(session: CodingSession) {
  return {
    id: session.id,
    title: session.title,
    url: session.url,
    state: codingSessionState(session),
    pullRequests: session.pullRequests,
    lastActivity: formatUserDateTime(session.updatedAt),
  };
}

export const codingSessionsAuthenticator = "coding-sessions";

const maxWatchMs = 24 * 60 * 60 * 1000;
const maxRelayedMessageChars = 4000;

export const watchTickSchema = z.object({
  sessionId: z.string().min(1),
  startedAt: z.number().int(),
  attempt: z.number().int().nonnegative(),
});

export type WatchTick = z.infer<typeof watchTickSchema>;

const notableStates = ["needs_input", "needs_approval", "finished", "halted", "failed"] as const;

type NotableState = (typeof notableStates)[number];

export const codingUpdateSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().nullable(),
  url: z.string(),
  state: z.enum(notableStates),
  pullRequests: z.array(z.object({ url: z.string(), state: z.string().nullable() })),
  latestMessage: z.string().nullable(),
});

export type CodingUpdate = z.infer<typeof codingUpdateSchema>;

const stoppedStates: ReadonlySet<CodingSessionState> = new Set([
  "asleep",
  "stopped",
  "halted",
  "failed",
  "ended",
]);

function isNotable(state: CodingSessionState): state is NotableState {
  return (notableStates as readonly string[]).includes(state);
}

// QStash re-delivers a tick until it succeeds, so every publish carries a deduplication id: a
// retried tick cannot fork the loop, and two loops on one session cannot text the same news twice.
function deduplicationId(...parts: (string | number)[]): string {
  return parts.join("-").replace(/[^\w-]/gu, "_");
}

// Devin goes quiet fast at first and then works for a while, so poll tightly early and back off.
function watchDelaySeconds(attempt: number): number {
  if (attempt < 15) return 60;
  if (attempt < 45) return 120;
  return 300;
}

export async function watchCodingSession(
  sessionId: string,
  tick: WatchTick = { sessionId, startedAt: Date.now(), attempt: 0 },
): Promise<void> {
  await publishCallback({
    url: env.codingSessionsWatchUrl,
    body: tick,
    delaySeconds: watchDelaySeconds(tick.attempt),
    deduplicationId: deduplicationId("coding-watch", sessionId, tick.startedAt, tick.attempt),
  });
}

// The session already exists by now, so a failure to watch it must not read as a failed start.
export async function tryWatchCodingSession(sessionId: string): Promise<boolean> {
  try {
    await watchCodingSession(sessionId);
    return true;
  } catch (error) {
    console.error(`[coding-sessions] failed to start watching ${sessionId}`, error);
    return false;
  }
}

// A watch runs until its session stops, so only a stopped session has no watch to pick up news.
export function isStopped(session: CodingSession): boolean {
  return stoppedStates.has(codingSessionState(session));
}

export function nextWatchTick(tick: WatchTick, session: CodingSession | null): WatchTick | null {
  if (session && isStopped(session)) return null;
  if (Date.now() - tick.startedAt > maxWatchMs) return null;
  return { ...tick, attempt: tick.attempt + 1 };
}

function latestDevinMessage(
  messages: readonly CodingSessionMessage[],
): CodingSessionMessage | undefined {
  return [...messages].reverse().find((message) => message.from === "devin");
}

export function codingUpdateFor(
  session: CodingSession,
  messages: readonly CodingSessionMessage[],
): { update: CodingUpdate; deduplicationId: string } | null {
  const state = codingSessionState(session);
  if (!isNotable(state)) return null;

  const latest = latestDevinMessage(messages);
  return {
    update: {
      sessionId: session.id,
      title: session.title,
      url: session.url,
      state,
      pullRequests: [...session.pullRequests],
      latestMessage: latest ? latest.text.slice(0, maxRelayedMessageChars) : null,
    },
    deduplicationId: deduplicationId(
      "coding-notify",
      session.id,
      state,
      latest?.id ?? session.updatedAt.getTime(),
    ),
  };
}

export async function publishCodingUpdate(update: CodingUpdate, deduplicationId: string): Promise<void> {
  await publishCallback({ url: env.codingSessionsNotifyUrl, body: update, deduplicationId });
}

const stateLines: Record<NotableState, string> = {
  needs_input: "It asked a question and is waiting for an answer before it carries on.",
  needs_approval: "It is waiting for someone to approve an action in its own app before it carries on.",
  finished: "It says the work is done.",
  halted: "It stopped before finishing, for example because a usage limit ran out.",
  failed: "It hit an error and stopped.",
};

export function codingUpdateMessage(update: CodingUpdate): string {
  const pullRequests = update.pullRequests.length
    ? update.pullRequests.map((pr) => `- ${pr.url}${pr.state ? ` (${pr.state})` : ""}`)
    : ["- none yet"];

  return [
    currentTimeContext(),
    "",
    "<coding_session_update>",
    `A coding session you started has news. ${stateLines[update.state]}`,
    `Session: ${update.title ?? "untitled"} (id ${update.sessionId})`,
    `Link: ${update.url}`,
    "Pull requests:",
    ...pullRequests,
    "",
    "Its latest message:",
    update.latestMessage?.trim() || "(none)",
    "</coding_session_update>",
    "",
    "Follow your coding session rules: text the user only if this is worth their attention, otherwise call the stay_silent tool.",
  ].join("\n");
}

export function codingSessionAuth(sessionId: string, owner: HomeOwner): SessionAuthContext {
  return ownerAuth(owner, {
    attributes: { session_id: sessionId },
    authenticator: codingSessionsAuthenticator,
  });
}
