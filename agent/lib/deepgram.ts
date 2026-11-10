import { z } from "zod";

import type { Transcript } from "#lib/transcription.js";

const listenUrl = "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true";

const listenSchema = z.object({
  metadata: z.object({ duration: z.number().nullish() }).nullish(),
  results: z.object({
    channels: z.array(
      z.object({
        detected_language: z.string().nullish(),
        alternatives: z.array(z.object({ transcript: z.string() })),
      }),
    ),
  }),
});

type Fetch = typeof fetch;

export async function deepgramTranscribe(
  apiKey: string,
  audio: { bytes: Uint8Array; mediaType: string },
  fetchImpl: Fetch = fetch,
): Promise<Transcript> {
  const response = await fetchImpl(listenUrl, {
    method: "POST",
    headers: { authorization: `Token ${apiKey}`, "content-type": audio.mediaType },
    body: new Blob([new Uint8Array(audio.bytes)], { type: audio.mediaType }),
  });
  if (!response.ok) {
    throw new Error(`Deepgram listen returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const { metadata, results } = listenSchema.parse(await response.json());
  const channel = results.channels[0];
  return {
    text: channel?.alternatives[0]?.transcript ?? "",
    language: channel?.detected_language ?? undefined,
    durationInSeconds: metadata?.duration ?? undefined,
  };
}
