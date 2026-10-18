import { del, get } from "@vercel/blob";
import { z } from "zod";

import { putConditional } from "#lib/blob-conditional.js";
import type { ClaimStore } from "#lib/daily-claim.js";
import { env } from "#lib/env.js";

const claimSchema = z.object({ day: z.string() });

function token(): string {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob is not configured");
  return env.BLOB_READ_WRITE_TOKEN;
}

function pathname(job: string): string {
  return `daily-claims/${job}.json`;
}

function parseDay(text: string): string | null {
  try {
    const parsed = claimSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.day : null;
  } catch {
    return null;
  }
}

export const blobClaimStore: ClaimStore = {
  async read(job) {
    const result = await get(pathname(job), { access: "private", token: token(), useCache: false });
    if (result?.statusCode !== 200) return null;

    return { day: parseDay(await new Response(result.stream).text()), etag: result.blob.etag };
  },
  async write(job, day, expected) {
    const { etag } = await putConditional(pathname(job), JSON.stringify({ day }), expected, token());
    return { etag };
  },
  async remove(job, etag) {
    await del(pathname(job), { token: token(), ifMatch: etag });
  },
};
