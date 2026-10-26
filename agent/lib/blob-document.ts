import { get } from "@vercel/blob";
import type { z } from "zod";

import { BlobWriteConflict, putConditional } from "#lib/blob-conditional.js";
import { env } from "#lib/env.js";
import { DocumentConflict, type DocumentStore } from "#lib/json-document.js";

function token(): string {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob is not configured");
  return env.BLOB_READ_WRITE_TOKEN;
}

// A corrupt document reads as `empty`, so the next write repairs it instead of wedging every caller.
export function blobDocumentStore<T>(pathname: string, schema: z.ZodType<T>, empty: T): DocumentStore<T> {
  return {
    async read() {
      const result = await get(pathname, { access: "private", token: token(), useCache: false });
      if (result === null) return null;
      if (result.statusCode !== 200) throw new Error(`${pathname} read returned ${result.statusCode}`);

      const text = await new Response(result.stream).text();
      return { value: parse(pathname, schema, text) ?? empty, etag: result.blob.etag };
    },
    async write(value, expected) {
      try {
        await putConditional(pathname, JSON.stringify(value), expected, token());
      } catch (error) {
        if (error instanceof BlobWriteConflict) throw new DocumentConflict(`${pathname} changed underneath the write`);
        throw error;
      }
    },
  };
}

function parse<T>(pathname: string, schema: z.ZodType<T>, text: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // falls through to the same repair path as a schema mismatch
  }
  console.warn(`[blob-document] ${pathname} is corrupt; treating it as empty so the next write repairs it`);
  return null;
}
