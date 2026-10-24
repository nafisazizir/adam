import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { callRequest } from "#evals/calls/fixtures.js";

const hasLink = satisfies((reply: string) => /https?:\/\/\S+/u.test(reply), "texts a link");

export default defineEval({
  description: "Call request: a link the caller asks for is spoken about on the call and texted in the same turn.",
  tags: ["calls"],
  async test(t) {
    const turn = await t.send(callRequest("can you text me the link to the sydney opera house website?"));
    t.succeeded();
    t.calledTool("reply_to_call", {
      input: { speech: (speech: unknown) => typeof speech === "string" && !/https?:\/\//u.test(speech) },
    });
    t.check(turn.message ?? "", hasLink);
  },
});
