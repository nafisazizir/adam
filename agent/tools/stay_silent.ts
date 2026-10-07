import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Send nothing this turn. Use it when the right reply is no message at all, such as an unremarkable workout debrief or a closed thread where nothing is owed.",
  endsTurn: true,
  inputSchema: z.object({}),
  async execute() {
    return { silent: true };
  },
});
