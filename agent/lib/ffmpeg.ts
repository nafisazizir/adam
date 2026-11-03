import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import ffmpegBinary from "@ffmpeg-installer/ffmpeg";

const execFileAsync = promisify(execFile);

const FFMPEG_TIMEOUT_MS = 30_000;

export async function runFfmpeg(args: readonly string[]): Promise<{ stderr: string }> {
  try {
    const { stderr } = await execFileAsync(ffmpegBinary.path, ["-nostdin", "-y", ...args], {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stderr };
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim().slice(-4000)
        : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ffmpeg failed: ${message}\nffmpeg stderr: ${stderr}`, { cause: error });
  }
}

export async function inScratchDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "adam-media-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
