import { defineEval } from "eve/evals";
import { assertHouseStyle } from "#evals/personality/style.js";

export default defineEval({
  description: "Right to silence: a low-signal acknowledgement gets a minimal reply, not a paragraph.",
  tags: ["personality"],
  async test(t) {
    await t.send("cool, thanks 🙏");
    t.completed();
    t.usedNoTools();
    assertHouseStyle(t);
    t.judge.autoevals
      .closedQA(
        "Keeps it minimal: at most a brief acknowledgement. Does NOT restate what was discussed, add a status report, or pad the reply with extra offers.",
      )
      .atLeast(0.7);
  },
});
