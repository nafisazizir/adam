import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";

import { assertMediaProvenance } from "#evals/personality/media.js";
import { assertHouseStyle } from "#evals/personality/style.js";

const noPhantomFailure = z
  .string()
  .refine(
    (s) => !/\b(404|dead link|broken link|didn'?t work|clip failed|text it is)\b/i.test(s),
    "apologises for a clip it never generated",
  );

export default defineEval({
  description:
    "Voice provenance: a mid-conversation voice-note ask is answered with a generated clip, never an invented media url.",
  tags: ["personality", "voice"],
  async test(t) {
    await t.send("just walked into the gym, feeling flat. talk me into this session");
    const turn = await t.send("actually can you say that as a voice note? hits different mid-set");
    t.succeeded();
    turn.calledTool("generate_speech");
    assertMediaProvenance(t, turn);
    t.check(turn.message ?? "", matches(noPhantomFailure));
    assertHouseStyle(t);
  },
});
