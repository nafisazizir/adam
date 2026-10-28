import "./ts-resolve.ts";

// `#lib/env.js` validates at import, so modules that read it load in tests without real secrets.
const requiredEnv = [
  "IMESSAGE_PROJECT_ID",
  "IMESSAGE_PROJECT_SECRET",
  "IMESSAGE_WEBHOOK_SECRET",
  "AI_GATEWAY_API_KEY",
  "STRAVA_WEBHOOK_VERIFY_TOKEN",
  "HEVY_WEBHOOK_SECRET",
  "NOTION_PLANS_DATA_SOURCE_ID",
  "NOTION_WORKOUTS_DATA_SOURCE_ID",
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "RIZ_MCP_JWT_SECRET",
];
for (const name of requiredEnv) process.env[name] ||= "test";
process.env.BASE_URL ||= "https://adam.test";
process.env.RIZ_MCP_URL ||= "https://riz-mcp.test";
process.env.DEVIN_API_KEY ||= "test-devin-key";
process.env.DEVIN_ORG_ID ||= "org-test";
process.env.CURSOR_API_KEY ||= "test-cursor-key";
