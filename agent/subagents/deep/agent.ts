import { defineAgent } from "eve";

export default defineAgent({
  description:
    "A deep worker on a larger model for heavy, multi-step work that would slow chat down: research across several sources, planning, comparing options, long drafts, and digging through the user's Notion. Returns a complete, sourced answer for Adam to relay. Not for training questions; those go to coach.",
  model: "openai/gpt-6.1-sol",
});
