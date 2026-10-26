import { get } from "@vercel/blob";
import type { z } from "zod";

import { BlobWriteConflict, putConditional } from "#lib/blob-conditional.js";
import { env } from "#lib/env.js";
import { DocumentConflict, type DocumentStore } from "#lib/json-document.js";

function token(): string {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob is not configured");
  return env.BLOB_READ_WRITE_TOKEN;
}

// These documents are the only record of what they hold, so a corrupt one fails loudly rather than
// reading as empty and being overwritten by the next write.
export function blobDocumentStore<T>(pathname: string, schema: z.ZodType<T>): DocumentStore<T> {
  return {
    async read() {
      const result = await get(pathname, { access: "private", token: token(), useCache: false });
      if (result === null) return null;
      if (result.statusCode !== 200) throw new Error(`${pathname} read returned ${result.statusCode}`);

      const text = await new Response(result.stream).text();
      return { value: parse(pathname, schema, text), etag: result.blob.etag };
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

function parse<T>(pathname: string, schema: z.ZodType<T>, text: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${pathname} in Blob is not JSON; fix or delete it by hand`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${pathname} in Blob does not match its schema; fix or delete it by hand`);
  return parsed.data;
}
