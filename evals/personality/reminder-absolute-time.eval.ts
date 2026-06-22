import { defineEval } from "eve/evals";
import { assertHouseStyle } from "#evals/personality/style.js";

export default defineEval({
  description: "Handles relative timing only: asks how long from now instead of silently assuming a clock time.",
  tags: ["personality", "behavior"],
  async test(t) {
    await t.send("remind me to take my meds at 9pm");
    const requests = t.expectInputRequests();
    t.waiting();
    assertHouseStyle(t);
    const question = requests[0]?.prompt ?? "";
    t.judge.autoevals
      .closedQA(
        "Asks the user how long from now the reminder should fire, rather than silently assuming an absolute clock time. A short, casual question counts as success.",
        { on: question },
      )
      .atLeast(0.7);
  },
});
