import { defineTool } from "eve/tools";
import { z } from "zod";

import { describeCodingSession, tryWatchCodingSession } from "#lib/coding-sessions.js";
import { sendCodingSessionMessage } from "#lib/devin.js";

export default defineTool({
  description:
    "Send a message to a coding session: answer a question it asked, pass on the user's " +
    "feedback, or redirect the work. A sleeping session wakes up when it gets a message. Write " +
    "it self-contained, since the coding agent cannot see this chat.",
  inputSchema: z.object({
    sessionId: z.string().min(1).describe("The session id."),
    message: z.string().min(1).describe("The message for the coding agent."),
  }),
  label: { start: () => "Message coding session" },
  async execute({ sessionId, message }) {
    const session = await sendCodingSessionMessage(sessionId, message);
    return { ...describeCodingSession(session), watching: await tryWatchCodingSession(session) };
  },
});
