import { BlobError, BlobPreconditionFailedError, put } from "@vercel/blob";

export class BlobWriteConflict extends Error {}

export type ExpectedBlob = { readonly etag: string } | "absent";

// The server's wording is the only signal for the plain BlobError cases: a create that lost the
// race says "already exists", and an ifMatch write to a deleted blob says "does not exist".
export function isBlobWriteConflict(error: unknown): boolean {
  if (error instanceof BlobWriteConflict || error instanceof BlobPreconditionFailedError) return true;
  return error instanceof BlobError && /already exists|does not exist/iu.test(error.message);
}

export async function putConditional(
  pathname: string,
  body: string,
  expected: ExpectedBlob,
  token: string,
): Promise<{ etag: string }> {
  try {
    const { etag } = await put(pathname, body, {
      access: "private",
      addRandomSuffix: false,
      contentType: "application/json",
      token,
      ...(expected === "absent" ? { allowOverwrite: false } : { allowOverwrite: true, ifMatch: expected.etag }),
    });
    return { etag };
  } catch (error) {
    if (isBlobWriteConflict(error)) throw new BlobWriteConflict("blob changed underneath the write", { cause: error });
    throw error;
  }
}
