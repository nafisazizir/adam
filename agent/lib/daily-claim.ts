import { get, put } from "@vercel/blob";
import { z } from "zod";

import { env } from "#lib/env.js";

const claimSchema = z.object({ day: z.string() });

async function readClaim(pathname: string, token: string) {
  const result = await get(pathname, { access: "private", token, useCache: false });
  if (result?.statusCode !== 200) return null;

  const text = await new Response(result.stream).text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const parsed = claimSchema.safeParse(payload);
  return { day: parsed.success ? parsed.data.day : null, etag: result.blob.etag };
}

// Vercel Cron can deliver the same run twice. A conditional write on one pointer per job lets
// exactly one of them claim the day; any failure counts as not claimed, so a run is missed
// rather than sent twice.
export async function claimDay(job: string, day: string): Promise<boolean> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return false;

  const pathname = `daily-claims/${job}.json`;
  try {
    const current = await readClaim(pathname, token);
    if (current?.day === day) return false;

    await put(pathname, JSON.stringify({ day }), {
      access: "private",
      addRandomSuffix: false,
      contentType: "application/json",
      token,
      ...(current ? { allowOverwrite: true, ifMatch: current.etag } : { allowOverwrite: false }),
    });
    return true;
  } catch (error) {
    console.warn(`[daily-claim] could not claim ${job} for ${day}`, error);
    return false;
  }
}
