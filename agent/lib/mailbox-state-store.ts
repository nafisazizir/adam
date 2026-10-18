import { get } from "@vercel/blob";

import { BlobWriteConflict, putConditional } from "#lib/blob-conditional.js";
import { env } from "#lib/env.js";
import { mailboxStateSchema, MailboxStateConflict, type MailboxStateStore } from "#lib/new-mail.js";

function token(): string {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob is not configured");
  return env.BLOB_READ_WRITE_TOKEN;
}

function pathname(account: string): string {
  return `mailboxes/${account}.json`;
}

export const blobMailboxStateStore: MailboxStateStore = {
  async read(account) {
    const result = await get(pathname(account), { access: "private", token: token(), useCache: false });
    if (result === null) return null;
    if (result.statusCode !== 200) throw new Error(`mailbox state read returned ${result.statusCode}`);

    const state = mailboxStateSchema.parse(JSON.parse(await new Response(result.stream).text()));
    return { state, etag: result.blob.etag };
  },
  async write(account, state, expected) {
    try {
      return await putConditional(pathname(account), JSON.stringify(state), expected, token());
    } catch (error) {
      if (error instanceof BlobWriteConflict) throw new MailboxStateConflict("mailbox state changed underneath the write");
      throw error;
    }
  },
};
