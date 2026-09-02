import { del, get, put } from "@vercel/blob";

import { env } from "#lib/env.js";

const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";

export interface PublishableAsset {
  data: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface StoredAsset {
  data: Uint8Array;
  mimeType: string;
}

function requireToken(): string {
  if (!env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "No blob store is configured, so I cannot host this file: connect a Vercel Blob store.",
    );
  }
  return env.BLOB_READ_WRITE_TOKEN;
}

export function isPublishedHere(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname.endsWith(BLOB_HOST_SUFFIX);
  } catch {
    return false;
  }
}

// The seam for turning bytes into a URL that stands in for them. Swapping
// stores (S3, R2) is this file; callers only ever see the URL.
export async function publishAsset({
  data,
  filename,
  mimeType,
}: PublishableAsset): Promise<string> {
  const { url } = await put(filename, Buffer.from(data), {
    access: "private",
    addRandomSuffix: true,
    contentType: mimeType,
    token: requireToken(),
  });

  return url;
}

// The store is private, so a URL alone reads nothing; only this side of the
// seam can turn one back into bytes. Returns null for URLs we did not publish.
export async function readAsset(
  rawUrl: string,
  abortSignal?: AbortSignal,
): Promise<StoredAsset | null> {
  if (!isPublishedHere(rawUrl)) return null;

  const result = await get(rawUrl, {
    abortSignal,
    access: "private",
    token: requireToken(),
  });
  if (result?.statusCode !== 200) {
    console.warn("[assets:read.rejected]", { statusCode: result?.statusCode ?? null });
    return null;
  }

  return {
    data: new Uint8Array(await new Response(result.stream).arrayBuffer()),
    mimeType: result.blob.contentType,
  };
}

// Hosting is only a handoff: once a channel has the bytes, the stored copy is
// dead weight. URLs we did not publish are left alone.
export async function releaseAssets(urls: string[]): Promise<void> {
  const ours = urls.filter(isPublishedHere);
  if (ours.length === 0 || !env.BLOB_READ_WRITE_TOKEN) return;

  await del(ours, { token: env.BLOB_READ_WRITE_TOKEN });
}
