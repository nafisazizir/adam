import { defineMcpClientConnection } from "eve/connections";

import { env } from "#lib/env.js";
import { mintAccessToken } from "#lib/riz-mcp.js";

export default defineMcpClientConnection({
  url: env.RIZ_MCP_URL,
  description:
    "riz-mcp: the user's personal health and fitness data. Strava activities and athlete stats, Garmin recovery metrics (sleep, HRV, body battery, stress, steps), and Hevy strength training (workouts, routines, exercise history, body measurements).",
  auth: {
    getToken: async () => mintAccessToken(),
  },
});
