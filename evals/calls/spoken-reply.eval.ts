import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { callRequest, requestNonce } from "#evals/calls/fixtures.js";
import { callReplyIn, type CallReply } from "#lib/calls.js";

// Runs the calls route's own stream scan over the turn's real events, so a change in eve's event
// shapes fails here rather than on a live call.
const heardOnTheCall = (speech: unknown) =>
  satisfies(
    (reply: CallReply | null) => reply?.kind === "speech" && reply.speech === speech,
    "the stream scan finds the spoken reply",
  );

export default defineEval({
  description: "Call request: Adam answers the caller through reply_to_call, briefly and in plain speech.",
  tags: ["calls"],
  async test(t) {
    const turn = await t.send(callRequest("how many days is it until new year's eve?"));
    t.succeeded();
    t.calledTool("reply_to_call", {
      input: { speech: (speech: unknown) => typeof speech === "string" && speech.length <= 300 },
    });
    const speech = turn.toolCalls.find((call) => call.name === "reply_to_call")?.input;
    t.check(callReplyIn(turn.events, requestNonce), heardOnTheCall(speech?.["speech"]));
    t.judge(
      "This is the input of a tool that speaks on a phone call. Its speech gives a number of days left until new year's eve, in one to three short sentences that sound natural said out loud, with no markdown, lists or links.",
      { on: speech ?? null },
    ).atLeast(0.7);
  },
});
