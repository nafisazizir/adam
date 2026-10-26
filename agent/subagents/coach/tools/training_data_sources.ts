import { defineTool } from "eve/tools";
import { z } from "zod";

import { env } from "#lib/env.js";

export default defineTool({
  description:
    "The Notion data sources that hold the user's training plan (one page per block) and their saved workout " +
    "analyses. Call it when a request needs the plan or past analyses and does not name the data sources.",
  inputSchema: z.object({}),
  async execute() {
    return { trainingPlan: env.NOTION_PLANS_DATA_SOURCE_ID, workouts: env.NOTION_WORKOUTS_DATA_SOURCE_ID };
  },
});
