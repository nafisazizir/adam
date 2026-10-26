import { defineEval } from "eve/evals";

export default defineEval({
  description: "Past call: a detail from an earlier call this thread lacks is looked up among saved calls, not guessed.",
  tags: ["calls"],
  async test(t) {
    await t.send("on my call with you this morning I mentioned a restaurant I wanted to book. what was it called again?");
    t.succeeded();
    t.calledTool("list_calls");
  },
});
