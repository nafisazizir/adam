import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";

import { assertHouseStyle } from "#evals/personality/style.js";

const noAttachment = z
  .string()
  .refine((s) => !/!\[[^\]]*\]\(/.test(s), "attaches media to a plain-text answer");

export default defineEval({
  description: "Voice is sparing: an ordinary ask stays plain text, no speech generated.",
  tags: ["personality", "style", "voice"],
  async test(t) {
    await t.send("any tips for actually waking up at 5am?");
    t.succeeded();
    t.notCalledTool("generate_speech");
    t.check(t.reply ?? "", matches(noAttachment));
    assertHouseStyle(t);
  },
});
