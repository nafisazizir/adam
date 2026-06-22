import { defineEval } from "eve/evals";
import { assertHouseStyle } from "#evals/personality/style.js";

export default defineEval({
  description: "Surfaces a concrete proactive next step when one obviously helps, without over-pitching.",
  tags: ["personality"],
  async test(t) {
    await t.send("ugh i keep forgetting to email my landlord back about the lease");
    t.completed();
    assertHouseStyle(t);
    t.judge.autoevals
      .closedQA(
        "Offers a concrete, useful next step, such as setting a reminder or helping draft the email, in a natural friend-like voice. The offer is specific and lightweight, NOT a salesy pitch or a list of everything it can do.",
      )
      .atLeast(0.7);
  },
});
