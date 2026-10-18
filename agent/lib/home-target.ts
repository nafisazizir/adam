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

export type HomeTargetRead =
  | { readonly status: "found"; readonly home: HomeTarget }
  | { readonly status: "absent" }
  | { readonly status: "unconfigured" }
  | { readonly status: "invalid"; readonly reason: string };

// Only a 404 is "absent": callers deciding who the owner is must not mistake a broken pointer for
// a fresh install.
export async function readHomeTargetState(): Promise<HomeTargetRead> {
  const blobToken = token();
  if (!blobToken) return { status: "unconfigured" };

  const result = await get(pathname, { access: "private", token: blobToken });
  if (result === null) return { status: "absent" };
  if (result.statusCode !== 200) return { status: "invalid", reason: `status ${result.statusCode}` };

  const text = await new Response(result.stream).text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { status: "invalid", reason: "not JSON" };
  }

  const parsed = homeTargetSchema.safeParse(payload);
  return parsed.success
    ? { status: "found", home: parsed.data }
    : { status: "invalid", reason: "does not match the home target schema" };
}

export async function readHomeTarget(): Promise<HomeTarget | null> {
  const read = await readHomeTargetState();
  return read.status === "found" ? read.home : null;
}
