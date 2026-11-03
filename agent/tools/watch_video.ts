import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import { transcribeAudio } from "#lib/transcription.js";
import { videoFrames } from "#lib/video-frames.js";

async function soundTrackText(data: Uint8Array): Promise<string | null> {
  try {
    const { text } = await transcribeAudio({ data, mediaType: "video/mp4" });
    return text.trim().length > 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

export default defineTool({
  description:
    "Watch a video the user sent: returns stills spread across it and a transcript of anything said in it. Pass the sandbox path from its `Attached file … (video/…)` reference. Use it before replying to any message that carries a video.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Sandbox path from the video attachment's `Attached file …` reference."),
  }),
  async execute({ path }, ctx) {
    const sandbox = await ctx.getSandbox();
    const data = await sandbox.readBinaryFile({ path });
    if (data === null) return { error: `No file at ${path}.` };

    const [frames, transcript] = await Promise.all([videoFrames(data), soundTrackText(data)]);
    return {
      frames: frames.map((frame) => ({
        atSeconds: frame.atSeconds,
        jpegBase64: frame.jpeg.toString("base64"),
      })),
      transcript,
    };
  },
  toModelOutput(output) {
    if (output.frames === undefined) return toolOutput.text(output.error ?? "The video could not be read.");
    return toolOutput.content([
      toolOutputPart.text(
        output.transcript === null
          ? "Nothing said in it could be made out."
          : `What is said in it: ${output.transcript}`,
      ),
      ...output.frames.flatMap((frame) => [
        toolOutputPart.text(`At ${frame.atSeconds}s:`),
        toolOutputPart.file(frame.jpegBase64, { mediaType: "image/jpeg" }),
      ]),
    ]);
  },
});
