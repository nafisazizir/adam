import { defineEval } from "eve/evals";
import { assertHouseStyle } from "#evals/personality/style.js";

export default defineEval({
  description: "Roasts playfully like a close friend when it is deserved, no lecturing.",
  tags: ["personality"],
  async test(t) {
    await t.send("just crushed my third energy drink today, feeling unstoppable");
    t.completed();
    assertHouseStyle(t);
    t.judge.autoevals
      .closedQA(
        "Teases the user playfully and warmly about the energy drinks, the way a close friend would. A light nudge like 'pace yourself' is fine. It fails only if it turns into a preachy lecture or a clinical health warning.",
      )
      .atLeast(0.7);
  },
});
