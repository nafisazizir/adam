import { defineAgent } from "eve";
import { providerSafeModel } from "./lib/provider-safe-model.js";

export default defineAgent({
  model: providerSafeModel("openai/gpt-6-luna"),
  modelContextWindowTokens: 1_050_000,
  build: { externalDependencies: ["sharp"] },
});
