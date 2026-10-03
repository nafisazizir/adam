import crypto from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { env } from "#lib/env.js";

const TOKEN_TTL_SECONDS = 3600;

function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  expiresInSeconds: number,
): { token: string; expiresAt: number } {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");

  const now = Math.floor(Date.now() / 1000);
  const exp = now + expiresInSeconds;
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: now, exp }),
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");

  return { token: `${header}.${body}.${signature}`, expiresAt: exp * 1000 };
}

export function mintAccessToken(): { token: string; expiresAt: number } {
  return signJwt(
    { type: "access_token", client_id: "adam", scope: "mcp:tools" },
    env.RIZ_MCP_JWT_SECRET,
    TOKEN_TTL_SECONDS,
  );
}

export const rizMcpConnection = {
  url: env.RIZ_MCP_URL,
  description:
    "riz-mcp: the user's personal health and fitness data. Strava activities and athlete stats, Garmin recovery metrics (sleep, HRV, body battery, stress, steps), and Hevy strength training (workouts, routines, exercise history, body measurements).",
  auth: {
    getToken: async () => mintAccessToken(),
  },
};

export async function callRizMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(new URL(env.RIZ_MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${mintAccessToken().token}` },
    },
  });
  const client = new Client({ name: "adam", version: "0.0.0" });

  try {
    await client.connect(transport);
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as CallToolResult;
    const textContent = result.content
      .filter((content) => content.type === "text")
      .map((content) => content.text);

    if (result.isError) {
      throw new Error(textContent.join("\n"));
    }
    if (!textContent[0]) {
      throw new Error(`riz-mcp tool ${name} returned no text content`);
    }

    return JSON.parse(textContent[0]);
  } finally {
    await client.close();
  }
}
