import { defineTool } from "eve/tools";
import { z } from "zod";

import { describeCodingSession } from "#lib/coding-sessions.js";
import { archiveCodingSession } from "#lib/devin.js";

export default defineTool({
  description:
    "Stop a coding session the user no longer wants, so it stops working and spending. It " +
    "goes to sleep rather than being destroyed, so a later message can still resume it.",
  inputSchema: z.object({
    sessionId: z.string().min(1).describe("The session id."),
  }),
  label: { start: () => "Stop coding session" },
  async execute({ sessionId }) {
    return describeCodingSession(await archiveCodingSession(sessionId));
  },
});
