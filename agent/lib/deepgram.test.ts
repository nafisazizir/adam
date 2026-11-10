import assert from "node:assert/strict";
import { test } from "node:test";

import { deepgramTranscribe } from "#lib/deepgram.js";

test("Deepgram's first channel becomes the transcript", async () => {
  let auth: string | null = null;
  const transcript = await deepgramTranscribe("dg-key", { bytes: new Uint8Array([1, 2]), mediaType: "audio/wav" }, async (_url, init) => {
    auth = new Headers(init?.headers).get("authorization");
    return Response.json({
      metadata: { duration: 3.2 },
      results: { channels: [{ detected_language: "en", alternatives: [{ transcript: "Call me in five." }] }] },
    });
  });
  assert.equal(auth, "Token dg-key");
  assert.deepEqual(transcript, { text: "Call me in five.", language: "en", durationInSeconds: 3.2 });
});

test("a Deepgram error surfaces with its status", async () => {
  await assert.rejects(
    deepgramTranscribe("dg-key", { bytes: new Uint8Array(), mediaType: "audio/wav" }, async () => new Response("nope", { status: 401 })),
    /Deepgram listen returned 401/u,
  );
});
