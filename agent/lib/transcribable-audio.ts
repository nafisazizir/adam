import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inScratchDir, runFfmpeg } from "#lib/ffmpeg.js";

const transcribableMediaTypes = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
]);

// Anything ffmpeg can demux works here, including a video, whose sound track is what gets kept.
export async function toTranscribableAudio(
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const normalizedMediaType = mediaType.split(";", 1)[0].trim().toLowerCase();

  if (transcribableMediaTypes.has(normalizedMediaType)) {
    return { bytes, mediaType };
  }

  return inScratchDir(async (dir) => {
    const inputPath = join(dir, "input");
    const outputPath = join(dir, "output.wav");
    await writeFile(inputPath, bytes);
    await runFfmpeg(["-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", outputPath]);
    return { bytes: await readFile(outputPath), mediaType: "audio/wav" };
  });
}
