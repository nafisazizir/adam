import { defineEval } from "eve/evals";

export default defineEval({
  description: "Memory: passing small talk is not saved.",
  tags: ["memory"],
  async test(t) {
    await t.send("had a flat white from the new place on my street this morning, pretty mid tbh");
    t.succeeded();
    t.notCalledTool("owner__save_memory");
  },
});
