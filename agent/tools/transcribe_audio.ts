import { extname } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { transcribeAudio } from "#lib/transcription.js";

const mediaTypeByExtension: Record<string, string> = {
  ".caf": "audio/x-caf",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".amr": "audio/amr",
  ".aac": "audio/aac",
};

function inferMediaType(path: string): string {
  return mediaTypeByExtension[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export default defineTool({
  description:
    "Transcribe an audio file into text, such as a voice note the user sent. Pass the sandbox path from its `Attached file … (audio/…)` reference. Use it before replying to any message that carries an audio attachment.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Sandbox path from the audio attachment's `Attached file …` reference."),
    mediaType: z
      .string()
      .optional()
      .describe("The audio/* type shown in that reference, if any."),
  }),
  async execute({ path, mediaType }, ctx) {
    const sandbox = await ctx.getSandbox();
    const data = await sandbox.readBinaryFile({ path });

    if (data === null) {
      return { error: `No file at ${path}.` };
    }

    return transcribeAudio({
      data,
      mediaType: mediaType ?? inferMediaType(path),
    });
  },
});
