import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import ffmpeg from "@ffmpeg-installer/ffmpeg";

const execFileAsync = promisify(execFile);

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

export async function toTranscribableAudio(
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const normalizedMediaType = mediaType.split(";", 1)[0].trim().toLowerCase();

  if (transcribableMediaTypes.has(normalizedMediaType)) {
    return { bytes, mediaType };
  }

  const directory = await mkdtemp(join(tmpdir(), "adam-transcribable-audio-"));
  const inputPath = join(directory, "input.caf");
  const outputPath = join(directory, "output.wav");

  try {
    await writeFile(inputPath, bytes);
    await execFileAsync(
      ffmpeg.path,
      [
        "-nostdin",
        "-y",
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        outputPath,
      ],
      { timeout: 30_000 },
    );

    return { bytes: await readFile(outputPath), mediaType: "audio/wav" };
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim().slice(-4000)
        : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ffmpeg failed: ${message}\nffmpeg stderr: ${stderr}`, { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
