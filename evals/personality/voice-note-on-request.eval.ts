import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";

const attachesAudio = z
  .string()
  .refine(
    (s) => /!\[[^\]]*\]\(\s*<?https:\/\/[^)\s>]+/.test(s),
    "does not embed the generated clip as ![](url)",
  );

export default defineEval({
  description: "Voice on request: an explicit ask for a voice note produces an embedded clip.",
  tags: ["personality", "voice"],
  async test(t) {
    const turn = await t.send("send me that as a voice note: good luck at the race tomorrow");
    t.succeeded();
    t.calledTool("generate_speech");
    t.check(turn.message ?? "", matches(attachesAudio));
  },
});
