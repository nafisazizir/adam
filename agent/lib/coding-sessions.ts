import type { CodingSession } from "#lib/devin.js";
import { env } from "#lib/env.js";
import { formatUserDateTime } from "#lib/time.js";

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
