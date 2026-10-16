import { defineEval } from "eve/evals";

import { needsInputUpdate } from "#evals/coding/updates.js";
import { assertHouseStyle } from "#evals/personality/style.js";
import { codingUpdateMessage } from "#lib/coding-sessions.js";

export default defineEval({
  description: "Coding session update: a question from the coding agent reaches the user in a line.",
  tags: ["coding"],
  async test(t) {
    const turn = await t.send(codingUpdateMessage(needsInputUpdate));
    t.succeeded();
    t.usedNoTools();
    const reply = turn.message ?? "";
    assertHouseStyle(t, reply);
    t.judge(
      "Relays the coding agent's question (read-only calendar access versus also creating and moving events) briefly, in a casual voice, so the user can answer. It does NOT paste the agent's message wholesale or add a long preamble.",
    ).atLeast(0.7);
  },
});
