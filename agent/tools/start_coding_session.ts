import { defineTool } from "eve/tools";
import { z } from "zod";

import { codingBrief, describeCodingSession, resolveRepo } from "#lib/coding-sessions.js";
import { createCodingSession } from "#lib/devin.js";

export default defineTool({
  description:
    "Hand engineering work to a cloud coding agent that works in a GitHub repo and opens a " +
    "pull request. Use it to build a capability you are missing or to fix a bug, in your own " +
    "codebase or another repo. It cannot see this chat, so the brief must carry everything: " +
    "what to build or fix and why, what the user was trying to do, what happened instead " +
    "(exact errors or behavior), and what done looks like. Returns the session id and link.",
  inputSchema: z.object({
    brief: z
      .string()
      .min(1)
      .describe("The full task brief, written for an engineer who has not seen this chat."),
    title: z.string().min(1).max(80).describe("A short title for the session."),
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/u)
      .optional()
      .describe("GitHub repo as owner/name. Omit it to work on your own codebase."),
  }),
  label: { start: ({ title }) => `Start coding session: ${title}` },
  async execute({ brief, title, repo }, ctx) {
    const target = resolveRepo(repo);
    if (!target) {
      throw new Error("This deployment does not know its own repo; name the repo as owner/name.");
    }

    const session = await createCodingSession({
      prompt: codingBrief(brief, target),
      title,
      repo: target,
      idempotencyKey: ctx.callId,
    });

    return describeCodingSession(session);
  },
});
