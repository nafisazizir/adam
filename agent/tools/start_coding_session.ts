import { defineTool } from "eve/tools";
import { z } from "zod";

import { codingBrief, describeCodingSession, resolveRepos } from "#lib/coding-sessions.js";
import { createCodingSession } from "#lib/devin.js";

export default defineTool({
  description:
    "Hand engineering work to a cloud coding agent that works in one or more GitHub repos " +
    "and opens pull requests. Use it to build a capability you are missing or to fix a bug, in " +
    "your own codebase, other repos, or several at once. It cannot see this chat, so the brief must carry everything: " +
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
        "GitHub repos as owner/name, from list_coding_repos; list every repo the work spans, " +
          "including your own if it is one of them. Omit it to work on your own codebase alone.",
      ),
  }),
  label: { start: ({ title }) => `Start coding session: ${title}` },
  async execute({ brief, title, repos }, ctx) {
    const targets = resolveRepos(repos);
    if (targets.length === 0) {
      throw new Error("This deployment does not know its own repo; find it with list_coding_repos.");
    }

    const session = await createCodingSession({
      prompt: codingBrief(brief, targets),
      title,
      repos: targets,
      idempotencyKey: ctx.callId,
    });

    return describeCodingSession(session);
  },
});
