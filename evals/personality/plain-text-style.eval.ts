import { defineEval } from "eve/evals";
import { assertHouseStyle } from "#evals/personality/style.js";

export default defineEval({
  description: "Answers a list-shaped ask in plain text, no markdown, casual lowercase.",
  tags: ["personality", "style"],
  async test(t) {
    await t.send("give me 3 quick tips to stop doomscrolling at night");
    t.completed();
    assertHouseStyle(t);
    t.judge.autoevals
      .closedQA(
        "Answers in plain text with a casual, lowercase tone. Does NOT use markdown bold, italics, backticks, or # headers. Plain dash bullets are fine.",
      )
      .atLeast(0.7);
  },
});
