import { get } from "@vercel/blob";

import { BlobWriteConflict, putConditional } from "#lib/blob-conditional.js";
import { env } from "#lib/env.js";
import { GoogleAccountsConflict, type GoogleAccountStore, parseGoogleAccountsDocument } from "#lib/google-accounts.js";

const pathname = "google-accounts.json";

function token(): string {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob is not configured, so no Google account can be kept");
  return env.BLOB_READ_WRITE_TOKEN;
}

export const blobGoogleAccountStore: GoogleAccountStore = {
  async read() {
    const result = await get(pathname, { access: "private", token: token(), useCache: false });
    if (result === null) return null;
    if (result.statusCode !== 200) throw new Error(`Google account list read returned ${result.statusCode}`);

    return { accounts: parseGoogleAccountsDocument(await new Response(result.stream).text()), etag: result.blob.etag };
  },
  async write(accounts, expected) {
    try {
      await putConditional(pathname, JSON.stringify({ accounts }), expected, token());
    } catch (error) {
      if (error instanceof BlobWriteConflict) throw new GoogleAccountsConflict("Google account list changed underneath the write");
      throw error;
    }
  },
};
