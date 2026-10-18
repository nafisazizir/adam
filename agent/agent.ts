import { defineAgent } from "eve";
import { providerSafeModel } from "./lib/provider-safe-model.js";

export default defineAgent({
  model: providerSafeModel("openai/gpt-6-luna"),
  modelContextWindowTokens: 1_050_000,
  // The iMessage thread is Adam's only memory; a timed-out session would start it over empty.
  limits: { sessionTimeoutMs: false },
  build: { externalDependencies: ["sharp", "@ffmpeg-installer/ffmpeg", "playwright-core"] },
});
