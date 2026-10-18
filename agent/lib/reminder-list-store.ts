import { BlobError, BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { z } from "zod";

import { env } from "#lib/env.js";
import { ReminderListConflict, type ReminderListStore } from "#lib/reminder-list.js";

const pathname = "scheduled-reminders.json";

const documentSchema = z.object({
  reminders: z.array(z.object({ id: z.string(), message: z.string(), fireAt: z.string() })),
});

function token(): string {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob is not configured");
  return env.BLOB_READ_WRITE_TOKEN;
}

function isConflict(error: unknown): boolean {
  return error instanceof BlobPreconditionFailedError || (error instanceof BlobError && /already exists/iu.test(error.message));
}

export const blobReminderListStore: ReminderListStore = {
  async read() {
    const result = await get(pathname, { access: "private", token: token(), useCache: false });
    if (result === null) return null;
    if (result.statusCode !== 200) throw new Error(`reminder list read returned ${result.statusCode}`);

    const parsed = documentSchema.parse(JSON.parse(await new Response(result.stream).text()));
    return { reminders: parsed.reminders, etag: result.blob.etag };
  },
  async write(reminders, expected) {
    try {
      await put(pathname, JSON.stringify({ reminders }), {
        access: "private",
        addRandomSuffix: false,
        contentType: "application/json",
        token: token(),
        ...(expected === "absent" ? { allowOverwrite: false } : { allowOverwrite: true, ifMatch: expected.etag }),
      });
    } catch (error) {
      if (isConflict(error)) throw new ReminderListConflict("reminder list changed underneath the write");
      throw error;
    }
  },
};
