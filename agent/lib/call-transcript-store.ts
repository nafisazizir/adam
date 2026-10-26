import { get, list, put } from "@vercel/blob";

import {
  type CallTranscriptStore,
  isCallTranscriptId,
  parseCallTranscript,
  type SavedCall,
} from "#lib/call-transcripts.js";
import { env } from "#lib/env.js";

const prefix = "call-transcripts/";
const suffix = ".json";
const maxListPages = 10;

function token(): string {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob is not configured");
  return env.BLOB_READ_WRITE_TOKEN;
}

function pathname(conversationId: string): string {
  return `${prefix}${conversationId}${suffix}`;
}

function idOf(blobPathname: string): string | null {
  if (!blobPathname.startsWith(prefix) || !blobPathname.endsWith(suffix)) return null;
  const id = blobPathname.slice(prefix.length, -suffix.length);
  return isCallTranscriptId(id) ? id : null;
}

export const blobCallTranscriptStore: CallTranscriptStore = {
  async read(conversationId) {
    const result = await get(pathname(conversationId), { access: "private", token: token(), useCache: false });
    if (result === null) return null;
    if (result.statusCode !== 200) throw new Error(`call transcript read returned ${result.statusCode}`);

    return parseCallTranscript(await new Response(result.stream).text());
  },
  // A retried webhook writes the same call again, so overwriting is the idempotent outcome.
  async write(transcript, signal) {
    await put(pathname(transcript.conversationId), JSON.stringify(transcript), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      token: token(),
      abortSignal: signal,
    });
  },
  async list() {
    const calls: SavedCall[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxListPages; page += 1) {
      const result = await list({ prefix, cursor, token: token() });
      for (const blob of result.blobs) {
        const conversationId = idOf(blob.pathname);
        if (conversationId) calls.push({ conversationId, savedAt: blob.uploadedAt });
      }
      if (!result.hasMore || !result.cursor) break;
      cursor = result.cursor;
    }
    return calls;
  },
};
