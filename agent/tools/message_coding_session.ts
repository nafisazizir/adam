import { defineTool } from "eve/tools";
import { z } from "zod";

import { isCallTurn, notFromOwnerChat } from "#lib/calls.js";
import { codingProviderNames } from "#lib/coding-agent.js";
import { sendCodingSessionMessage } from "#lib/coding-agents.js";
import { describeCodingSession, tryWatchCodingSession } from "#lib/coding-sessions.js";

export default defineTool({
  description:
    "Send a message to a coding session: answer a question it asked, pass on the user's " +
    "feedback, or redirect the work. A sleeping session wakes up when it gets a message. Write " +
    "it self-contained, since the coding agent cannot see this chat.",
  inputSchema: z.object({
    sessionId: z.string().min(1).describe("The session id."),
    message: z.string().min(1).describe("The message for the coding agent."),
    provider: z
      .enum(codingProviderNames)
      .optional()
      .describe("The session's provider, when you have it. A Cursor id starts with bc- and needs nothing else."),
  }),
  label: { start: () => "Message coding session" },
  async execute({ sessionId, message, provider }, ctx) {
    if (isCallTurn(ctx.session.auth.current)) return { sent: false, reason: notFromOwnerChat };
    const session = await sendCodingSessionMessage(sessionId, message, provider);
    return { ...describeCodingSession(session), watching: await tryWatchCodingSession(session) };
  },
});
