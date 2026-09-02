import { put } from "@vercel/blob";

import { env } from "#lib/env.js";

export interface PublishableAsset {
  data: Uint8Array;
  filename: string;
  mimeType: string;
}

// The seam for turning bytes into a public https URL. Swapping stores (S3, R2)
// is this one function; callers only ever see the URL.
export async function publishAsset({
  data,
  filename,
  mimeType,
}: PublishableAsset): Promise<string> {
  if (!env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "No blob store is configured, so I cannot host this file: connect a Vercel Blob store.",
    );
  }

  const { url } = await put(filename, Buffer.from(data), {
    access: "public",
    addRandomSuffix: true,
    contentType: mimeType,
    token: env.BLOB_READ_WRITE_TOKEN,
  });

  return url;
}
