import { defineTool } from "eve/tools";
import { z } from "zod";

import { describeCodingSession } from "#lib/coding-sessions.js";
import { getCodingSession, listCodingSessionMessages } from "#lib/devin.js";
import { formatUserDateTime } from "#lib/time.js";

const recentMessageCount = 5;

export default defineTool({
  description:
    "Check on one coding session: its state, pull requests, and the latest messages between " +
    "you and the coding agent, including any question it is waiting on.",
  inputSchema: z.object({
    sessionId: z.string().min(1).describe("The session id from start_coding_session or list_coding_sessions."),
  }),
  async execute({ sessionId }) {
    const [session, messages] = await Promise.all([
      getCodingSession(sessionId),
      listCodingSessionMessages(sessionId),
    ]);

    return {
      ...describeCodingSession(session),
      recentMessages: messages.slice(-recentMessageCount).map((message) => ({
        from: message.from === "devin" ? "coding agent" : "you",
        text: message.text,
        at: formatUserDateTime(message.at),
      })),
    };
  },
});
