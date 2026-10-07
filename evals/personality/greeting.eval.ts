import { defineEval } from "eve/evals";
import { assertHouseStyle } from "#evals/personality/style.js";

export default defineEval({
  description: "A greeting gets a greeting, not a status report or capability dump.",
  tags: ["personality"],
  async test(t) {
    const turn = await t.send("yo");
    t.succeeded();
    t.usedNoTools();
    assertHouseStyle(t, turn.message ?? "");
    t.judge(
      "Replies with a short, casual greeting only. Does NOT dump a status report, a list of capabilities, or a menu of things it can do.",
    ).atLeast(0.7);
  },
});
