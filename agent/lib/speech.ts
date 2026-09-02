import { generateSpeech } from "ai";

import { env } from "#lib/env.js";

export interface SpokenAudio {
  data: Uint8Array;
  mimeType: string;
}

// The seam for text to audio. The model id routes through the AI Gateway, so
// changing provider or voice is config, not code.
export async function synthesizeSpeech(text: string, voice?: string): Promise<SpokenAudio> {
  const { audio } = await generateSpeech({
    model: env.SPEECH_MODEL,
    text,
    voice: voice ?? env.SPEECH_VOICE,
    outputFormat: "mp3",
  });

  return { data: audio.uint8Array, mimeType: audio.mediaType || "audio/mpeg" };
}
