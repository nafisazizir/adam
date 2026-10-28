import { defineTool } from "eve/tools";
import { z } from "zod";

import { isCallTurn, notFromOwnerChat } from "#lib/calls.js";
import { codingProviderNames } from "#lib/coding-agent.js";
import { createCodingSession } from "#lib/coding-agents.js";
import { codingBrief, describeCodingSession, tryWatchCodingSession } from "#lib/coding-sessions.js";
import { replayStableKey } from "#lib/replay-key.js";

export default defineTool({
  description:
    "Hand engineering work to a cloud coding agent that works in one or more GitHub repos " +
    "and opens pull requests. Use it to build a capability you are missing or to fix a bug, in " +
    "your own codebase, other repos, or several at once; it works out which repos from the " +
    "brief. It cannot see this chat, so the brief must carry everything: " +
    "what to build or fix and why, what the user was trying to do, what happened instead " +
    "(exact errors or behavior), and what done looks like. Returns the session id and link.",
  inputSchema: z.object({
    brief: z
      .string()
      .min(1)
      .describe("The full task brief, written for an engineer who has not seen this chat."),
    title: z.string().min(1).max(80).describe("A short title for the session."),
    repos: z
      .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/u))
      .max(10)
      .optional()
      .describe(
        "Repos as owner/name, only when the user named them; a hint, not a limit. Omit it to " +
          "let the coding agent pick from the brief. Cursor needs them named, since it starts on the repos you pass.",
      ),
    provider: z
      .enum(codingProviderNames)
      .optional()
      .describe("Which cloud coding agent to use, devin or cursor. Omit it for the configured default."),
  }),
  label: { start: ({ title }) => `Start coding session: ${title}` },
  async execute({ brief, title, repos, provider }, ctx) {
    if (isCallTurn(ctx.session.auth.current)) return { started: false, reason: notFromOwnerChat };
    const hinted = [...new Set(repos ?? [])];
    const session = await createCodingSession(
      {
        prompt: codingBrief(brief, hinted),
        title,
        repos: hinted,
        idempotencyKey: replayStableKey(ctx, title, brief, ...(provider ? [provider] : []), ...hinted),
      },
      provider,
    );

    return { ...describeCodingSession(session), watching: await tryWatchCodingSession(session) };
  },
});
