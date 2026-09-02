import { del, put } from "@vercel/blob";

import { env } from "#lib/env.js";

const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

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

function isPublishedHere(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname.endsWith(BLOB_HOST_SUFFIX);
  } catch {
    return false;
  }
}

// Hosting is only a handoff: once a channel has the bytes, a public URL for a
// generated clip is pure exposure. URLs we did not publish are left alone.
export async function releaseAssets(urls: string[]): Promise<void> {
  const ours = urls.filter(isPublishedHere);
  if (ours.length === 0 || !env.BLOB_READ_WRITE_TOKEN) return;

  await del(ours, { token: env.BLOB_READ_WRITE_TOKEN });
}
