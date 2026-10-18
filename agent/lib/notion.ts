import { connect } from "@vercel/connect/eve";

import { signInFromOwnerDirectChat } from "#lib/connection-auth.js";

export const notionConnection = {
  url: "https://mcp.notion.com/mcp",
  description:
    "Notion: the user's workspace, including their training plan and the workouts data source where post-workout analyses are saved. Search, fetch, query data sources, create and update pages.",
  auth: signInFromOwnerDirectChat(
    "Notion",
    connect({ connector: "scl_sEWJE8qn1g9bQcPsbDbxYQ", principalType: "user" }),
  ),
};
