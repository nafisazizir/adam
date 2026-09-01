import { defineEval } from "eve/evals";
import { fewBriefBubbles } from "#evals/personality/bubbles.js";
import { assertHouseStyle } from "#evals/personality/style.js";

export default defineEval({
  description: "Bubbles: a longer answer may split into a few bubbles, each one brief.",
  tags: ["personality", "style"],
  async test(t) {
    await t.send("should i learn rust or go first? i mostly do web backend stuff");
    t.succeeded();
    assertHouseStyle(t);
    t.check(t.reply ?? "", fewBriefBubbles);
    t.judge.autoevals
      .closedQA(
        "Gives a direct opinion in a casual texting voice. If the reply contains lines with only '---', each chunk between them is short, one or two sentences. Does NOT pad, hedge at length, or narrate.",
      )
      .atLeast(0.7);
  },
});
