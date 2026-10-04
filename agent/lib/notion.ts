import { connect } from "@vercel/connect/eve";

export const notionConnection = {
  url: "https://mcp.notion.com/mcp",
  description:
    "Notion: the user's workspace, including their training plan and the workouts data source where post-workout analyses are saved. Search, fetch, query data sources, create and update pages.",
  auth: connect({ connector: "notion", principalType: "app" }),
};
