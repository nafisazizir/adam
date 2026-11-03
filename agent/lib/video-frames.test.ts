import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";

import { inScratchDir, runFfmpeg } from "#lib/ffmpeg.js";
import { toTranscribableAudio } from "#lib/transcribable-audio.js";
import { videoFrames } from "#lib/video-frames.js";

async function clip(): Promise<Buffer> {
  return inScratchDir(async (dir) => {
    const path = join(dir, "clip.mp4");
    await runFfmpeg([
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-t", "4", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
    ]);
    return readFile(path);
  });
}

test("takes stills spread across a video, small enough to show the model", async () => {
  const frames = await videoFrames(await clip());
  assert.equal(frames.length, 6);
  assert.deepEqual(frames.map((frame) => frame.atSeconds), [0.3, 1, 1.7, 2.3, 3, 3.7]);
  const { width, height, format } = await sharp(frames[0]!.jpeg).metadata();
  assert.deepEqual([format, width, height], ["jpeg", 768, 432]);
});

test("pulls the sound track out of a video for transcription", async () => {
  const audio = await toTranscribableAudio(await clip(), "video/mp4");
  assert.equal(audio.mediaType, "audio/wav");
  assert.ok(audio.bytes.byteLength > 1000);
});
