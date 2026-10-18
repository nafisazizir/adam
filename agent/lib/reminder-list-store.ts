import { get } from "@vercel/blob";

import { BlobWriteConflict, putConditional } from "#lib/blob-conditional.js";
import { env } from "#lib/env.js";
import { parseReminderDocument, ReminderListConflict, type ReminderListStore } from "#lib/reminder-list.js";

const pathname = "scheduled-reminders.json";

function token(): string {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob is not configured");
  return env.BLOB_READ_WRITE_TOKEN;
}

export const blobReminderListStore: ReminderListStore = {
  async read() {
    const result = await get(pathname, { access: "private", token: token(), useCache: false });
    if (result === null) return null;
    if (result.statusCode !== 200) throw new Error(`reminder list read returned ${result.statusCode}`);

    return { reminders: parseReminderDocument(await new Response(result.stream).text()), etag: result.blob.etag };
  },
  async write(reminders, expected) {
    try {
      await putConditional(pathname, JSON.stringify({ reminders }), expected, token());
    } catch (error) {
      if (error instanceof BlobWriteConflict) throw new ReminderListConflict("reminder list changed underneath the write");
      throw error;
    }
  },
};
