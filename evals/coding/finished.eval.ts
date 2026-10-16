import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { finishedUpdate } from "#evals/coding/updates.js";
import { assertHouseStyle } from "#evals/personality/style.js";
import { codingUpdateMessage } from "#lib/coding-sessions.js";

const linksPullRequest = satisfies(
  (reply: string) => reply.includes("https://github.com/nafisazizir/adam/pull/42"),
  "includes the pull request link",
);

export default defineEval({
  description: "Coding session update: a finished session gets one short text with the PR and manual steps.",
  tags: ["coding"],
  async test(t) {
    const turn = await t.send(codingUpdateMessage(finishedUpdate));
    t.succeeded();
    t.usedNoTools();
    const reply = turn.message ?? "";
    t.check(reply, linksPullRequest);
    assertHouseStyle(t, reply);
    t.judge(
      "Tells the user the calendar work is done in a line, gives the pull request link, and mentions the manual steps they must do (adding the calendar connection and setting GOOGLE_CALENDAR_ID). It does NOT recite how the work was verified or paste the full summary.",
    ).atLeast(0.7);
  },
});
