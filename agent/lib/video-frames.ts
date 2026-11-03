import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inScratchDir, runFfmpeg } from "#lib/ffmpeg.js";

export interface VideoFrame {
  readonly atSeconds: number;
  readonly jpeg: Buffer;
}

const DEFAULT_FRAME_COUNT = 6;
const FRAME_MAX_SIDE = 768;
const fitInside = `scale=w='min(${FRAME_MAX_SIDE},iw)':h='min(${FRAME_MAX_SIDE},ih)':force_original_aspect_ratio=decrease`;

// Stills spread evenly across the video, each from the middle of its slice so a short clip
// never yields its black first frame.
export async function videoFrames(
  bytes: Uint8Array,
  { count = DEFAULT_FRAME_COUNT }: { count?: number } = {},
): Promise<VideoFrame[]> {
  return inScratchDir(async (dir) => {
    const inputPath = join(dir, "input");
    await writeFile(inputPath, bytes);

    const duration = await durationSeconds(inputPath);
    const moments =
      duration > 0
        ? Array.from({ length: count }, (_, index) => ((index + 0.5) * duration) / count)
        : [0];

    return Promise.all(
      moments.map(async (atSeconds, index) => {
        const outputPath = join(dir, `frame-${index}.jpg`);
        await runFfmpeg([
          "-ss",
          atSeconds.toFixed(3),
          "-i",
          inputPath,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          fitInside,
          "-q:v",
          "5",
          outputPath,
        ]);
        return { atSeconds: Math.round(atSeconds * 10) / 10, jpeg: await readFile(outputPath) };
      }),
    );
  });
}

async function durationSeconds(inputPath: string): Promise<number> {
  const { stderr } = await runFfmpeg(["-i", inputPath, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"]);
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/u.exec(stderr);
  if (!match) return 0;
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}
