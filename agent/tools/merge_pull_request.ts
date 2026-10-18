import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";

import { tryWatchCodingSession } from "#lib/coding-sessions.js";
import { isOwnerChat } from "#lib/delivery.js";
import { listCodingSessions, sendCodingSessionMessage } from "#lib/devin.js";
import {
  type MergeMethod,
  mergeMethodSchema,
  mergeRequest,
  pullRequestName,
  samePullRequest,
} from "#lib/pull-requests.js";

const searchedSessions = 100;

const notFromOwnerChat =
  "Merging needs the user's go-ahead in chat, and this turn did not come from them. " +
  "Ask them in chat, and merge when they say so.";

type Found =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly title: string | null;
      readonly state: string | null;
    }
  | { readonly ok: false; readonly reason: string };

// A background turn in the owner's thread (debrief, coding update) runs as another principal, so
// the owner's reply would queue behind a prompt parked there instead of answering it.
async function isOwnerChatTurn(ctx: WorkflowStepToolContext): Promise<boolean> {
  "use step";
  return isOwnerChat(ctx.session.auth.current);
}

async function findSessionFor(url: string): Promise<Found> {
  "use step";
  let sessions;
  try {
    sessions = await listCodingSessions(searchedSessions);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  for (const session of sessions) {
    const pr = session.pullRequests.find((candidate) => samePullRequest(candidate.url, url));
    if (pr) return { ok: true, sessionId: session.id, title: session.title, state: pr.state };
  }
  return {
    ok: false,
    reason: "none of your coding sessions opened that pull request, so it has to be merged on GitHub",
  };
}

async function askToMerge(sessionId: string, url: string, method: MergeMethod): Promise<boolean> {
  "use step";
  const session = await sendCodingSessionMessage(sessionId, mergeRequest(url, method));
  return tryWatchCodingSession(session);
}

export default defineWorkflowTool({
  description:
    "Merge a pull request that one of your coding sessions opened. Only call it when the user " +
    "has just said in chat to merge it. It sends them a confirmation naming the pull request, " +
    "and once they confirm, the coding agent merges it; the outcome arrives later as a coding " +
    "session update. It refuses a pull request no session of yours opened, or a turn the user " +
    "did not start, and says why.",
  inputSchema: z.object({
    url: z
      .string()
      .min(1)
      .describe("The pull request url, e.g. https://github.com/owner/repo/pull/123."),
    method: mergeMethodSchema
      .default("squash")
      .describe("How to merge. Squash unless the user asked otherwise."),
  }),
  label: { start: () => "Merge pull request" },
  async execute({ url, method }, ctx) {
    "use workflow";
    if (!(await isOwnerChatTurn(ctx))) return { requested: false, reason: notFromOwnerChat };

    const found = await findSessionFor(url);
    if (!found.ok) return { requested: false, reason: found.reason };
    if (found.state === "merged") return { requested: false, alreadyMerged: true, url };
    if (found.state === "closed") return { requested: false, reason: "it is closed", url };

    const name = pullRequestName(url);
    const answer = await ctx.ask({
      prompt: `Merge ${name}${found.title ? ` ("${found.title}")` : ""}? It gets ${method}-merged as it is now.`,
      display: "confirmation",
      options: [
        { id: "merge", label: "Merge", style: "primary" },
        { id: "cancel", label: "Cancel" },
      ],
    });
    if (answer.status !== "answered" || answer.optionId !== "merge") {
      return { requested: false, reason: "cancelled", url };
    }

    const watching = await askToMerge(found.sessionId, url, method);
    return { requested: true, url, sessionId: found.sessionId, watching };
  },
});
