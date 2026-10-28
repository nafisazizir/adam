import { defineTool } from "eve/tools";
import { z } from "zod";

import { codingProviderNames } from "#lib/coding-agent.js";
import { listCodingSessions } from "#lib/coding-agents.js";
import { describeCodingSession } from "#lib/coding-sessions.js";

export default defineTool({
  description:
    "List recent coding sessions you started, with each one's id, state, link and pull " +
    "requests. Use it to find a session the user refers to.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(10).describe("How many sessions to return."),
    provider: z
      .enum(codingProviderNames)
      .optional()
      .describe("Which provider's sessions to list. Omit it for the configured default."),
  }),
  async execute({ limit, provider }) {
    const sessions = await listCodingSessions(limit, provider);
    return { sessions: sessions.map(describeCodingSession) };
  },
});
