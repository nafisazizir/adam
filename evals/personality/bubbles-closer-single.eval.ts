import { defineEval } from "eve/evals";
import { singleShortBubble } from "#evals/personality/bubbles.js";
import { assertHouseStyle } from "#evals/personality/style.js";

export default defineEval({
  description: "Bubbles: a closing turn stays a single short bubble, never split.",
  tags: ["personality", "style"],
  async test(t) {
    const turn = await t.send("ok cool, night");
    t.succeeded();
    t.usedNoTools();
    const reply = turn.message ?? "";
    assertHouseStyle(t, reply);
    t.check(reply, singleShortBubble);
  },
});
