import { defineEval } from "eve/evals";

export default defineEval({
  description: "Memory: an injury the owner mentions is saved as a durable fact.",
  tags: ["memory"],
  async test(t) {
    await t.send("ugh i tore my calf at footy last night, physio says no running for 3 weeks");
    t.succeeded();
    t.calledTool("owner__save_memory", {
      input: { text: (text: unknown) => typeof text === "string" && /calf/i.test(text) && /run/i.test(text) },
      count: 1,
    });
    t.calledTool("schedule_reminder", { count: 0 });
  },
});
