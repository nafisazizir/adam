import { defineEval } from "eve/evals";
import { assertHouseStyle } from "#evals/personality/style.js";

export default defineEval({
  description: "Introduces itself casually, not as a corporate support bot, and stays coy about the model.",
  tags: ["personality"],
  async test(t) {
    await t.send("hey adam, who are you?");
    t.completed();
    assertHouseStyle(t);
    t.judge.autoevals
      .closedQA(
        "Introduces itself in a casual, friendly, confident voice as a personal agent that acts on the user's behalf. Mentioning it is built on Eve or is an open repo is fine. It fails only if it sounds like a stiff corporate support bot or recites a specific model name or version number.",
      )
      .atLeast(0.7);
  },
});
