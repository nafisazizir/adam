import { defineTool } from "eve/tools";
import { z } from "zod";

import { codingBrief, describeCodingSession, tryWatchCodingSession } from "#lib/coding-sessions.js";
import { createCodingSession } from "#lib/devin.js";
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
          "let the coding agent pick from the brief.",
      ),
  }),
  label: { start: ({ title }) => `Start coding session: ${title}` },
  async execute({ brief, title, repos }, ctx) {
    const hinted = [...new Set(repos ?? [])];
    const session = await createCodingSession({
      prompt: codingBrief(brief, hinted),
      title,
      repos: hinted,
      idempotencyKey: replayStableKey(ctx, title, brief, ...hinted),
    });

    return { ...describeCodingSession(session), watching: await tryWatchCodingSession(session) };
  },
});
