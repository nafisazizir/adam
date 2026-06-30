import crypto from "node:crypto";

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
