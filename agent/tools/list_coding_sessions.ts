import { defineTool } from "eve/tools";
import { z } from "zod";

import { describeCodingSession } from "#lib/coding-sessions.js";
import { listCodingSessions } from "#lib/devin.js";

export default defineTool({
  description:
    "List the coding sessions you started, most recently active first, with each one's id, " +
    "state, link and pull requests. Use it to find a session the user refers to.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(10).describe("How many sessions to return."),
  }),
  async execute({ limit }) {
    const sessions = await listCodingSessions(limit);
    return { sessions: sessions.map(describeCodingSession) };
  },
});
