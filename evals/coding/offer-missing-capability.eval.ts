import { defineEval } from "eve/evals";

import { assertHouseStyle } from "#evals/personality/style.js";

export default defineEval({
  description: "Coding sessions: a missing capability gets one offer to build it, not a silent start.",
  tags: ["coding"],
  async test(t) {
    const turn = await t.send("block out 2 to 4pm tomorrow on my calendar for deep work");
    t.succeeded();
    t.calledTool("start_coding_session", { count: 0 });
    assertHouseStyle(t, turn.message ?? "");
    t.judge(
      "Says plainly that it has no calendar access yet and offers to get that capability built, in a line or two. It does NOT claim the time was blocked, and does NOT bury the offer under a list of alternatives.",
    ).atLeast(0.7);
  },
});
