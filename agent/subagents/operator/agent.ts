import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Reads sites that need the owner's login, such as their X or LinkedIn notifications and " +
    "feed, in a hosted browser that stays logged in as them. Strictly read-only: it opens pages, " +
    "reads and scrolls, and returns what matters with links. It cannot post, like, reply, follow, " +
    "message or click. Plain public web research belongs to deep, not here.",
  model: "openai/gpt-6-luna",
  // No shell, file or open-web tools: page text is untrusted, so the browser tools are all it has.
  defaultTools: false,
  // Playwright reads its own package files at runtime, so it cannot be bundled.
  build: { externalDependencies: ["playwright-core"] },
});
