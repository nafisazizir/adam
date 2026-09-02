import { defineTool } from "eve/tools";
import { z } from "zod";

import { publishAsset } from "#lib/assets.js";
import { synthesizeSpeech } from "#lib/speech.js";

export default defineTool({
  description:
    "Turn text into a spoken audio clip and return a url standing in for it. " +
    "Embed that url as ![](url) in your reply and it arrives as a voice message; " +
    "the clip says exactly the text you pass, so write it the way you want it heard. " +
    "Use it only when hearing it beats reading it, never for a routine reply.",
  inputSchema: z.object({
    text: z.string().min(1).max(2000).describe("Exactly what should be spoken aloud."),
    voice: z
      .string()
      .min(1)
      .optional()
      .describe("Provider voice id. Omit for the default voice."),
  }),
  async execute({ text, voice }) {
    const { data, mimeType } = await synthesizeSpeech(text, voice);
    const url = await publishAsset({ data, filename: "voice-note.aac", mimeType });

    return { url };
  },
});
