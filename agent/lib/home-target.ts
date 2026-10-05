import { get, put } from "@vercel/blob";
import { z } from "zod";

import { env } from "#lib/env.js";

const pathname = "home-target.json";
const homeOwnerSchema = z.object({
  issuer: z.string(),
  principalId: z.string(),
});

const homeTargetSchema = z.object({
  channel: z.string(),
  target: z.record(z.string(), z.unknown()),
  owner: homeOwnerSchema,
});

export type HomeOwner = z.infer<typeof homeOwnerSchema>;

export type HomeTarget = z.infer<typeof homeTargetSchema>;

let lastWrittenJson: string | undefined;
let warnedMissingToken = false;

function token(): string | null {
  if (env.BLOB_READ_WRITE_TOKEN) return env.BLOB_READ_WRITE_TOKEN;

  if (!warnedMissingToken) {
    console.warn("[home-target] Vercel Blob is not configured; home target is unavailable");
    warnedMissingToken = true;
  }

  return null;
}

export async function rememberHomeTarget(home: HomeTarget): Promise<void> {
  const blobToken = token();
  if (!blobToken) return;

  const json = JSON.stringify(home);
  if (json === lastWrittenJson) return;

  await put(pathname, json, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token: blobToken,
  });
  lastWrittenJson = json;
}

export async function readHomeTarget(): Promise<HomeTarget | null> {
  const blobToken = token();
  if (!blobToken) return null;

  const result = await get(pathname, { access: "private", token: blobToken });
  if (result?.statusCode !== 200) return null;

  const text = await new Response(result.stream).text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = homeTargetSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
