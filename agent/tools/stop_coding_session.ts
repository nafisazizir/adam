import { defineTool } from "eve/tools";
import { z } from "zod";

import { isCallTurn, notFromOwnerChat } from "#lib/calls.js";
import { codingProviderNames } from "#lib/coding-agent.js";
import { archiveCodingSession } from "#lib/coding-agents.js";
import { describeCodingSession } from "#lib/coding-sessions.js";

export default defineTool({
  description:
    "Stop a coding session the user no longer wants, so it stops working and spending. It " +
    "goes to sleep rather than being destroyed, so a later message can still resume it.",
  inputSchema: z.object({
    sessionId: z.string().min(1).describe("The session id."),
    provider: z
      .enum(codingProviderNames)
      .optional()
      .describe("The session's provider, when you have it. A Cursor id starts with bc- and needs nothing else."),
  }),
  label: { start: () => "Stop coding session" },
  async execute({ sessionId, provider }, ctx) {
    if (isCallTurn(ctx.session.auth.current)) return { stopped: false, reason: notFromOwnerChat };
    return describeCodingSession(await archiveCodingSession(sessionId, provider));
  },
});
