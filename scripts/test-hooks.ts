import { registerHooks } from "node:module";

// Authored code imports `.js` specifiers that only exist as `.ts` until eve builds them.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.endsWith(".js")) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});

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
