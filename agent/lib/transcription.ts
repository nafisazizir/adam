import { experimental_transcribe } from "ai";

import { deepgramTranscribe } from "#lib/deepgram.js";
import { env } from "#lib/env.js";
import { toTranscribableAudio } from "#lib/transcribable-audio.js";

export interface Transcript {
  text: string;
  language?: string;
  durationInSeconds?: number;
}

export async function transcribeAudio(audio: {
  data: Uint8Array;
  mediaType: string;
}): Promise<Transcript> {
  const converted = await toTranscribableAudio(audio.data, audio.mediaType);
  if (env.DEEPGRAM_API_KEY) return deepgramTranscribe(env.DEEPGRAM_API_KEY, converted);

  const result = await experimental_transcribe({
    model: env.TRANSCRIPTION_MODEL,
    audio: converted.bytes,
  });

  return {
    text: result.text,
    language: result.language,
    durationInSeconds: result.durationInSeconds,
  };
}
