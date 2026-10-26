import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { googleBriefingMessage, quietDay } from "#evals/briefing/google.js";

const silent = satisfies((reply: string) => reply.trim() === "", "an empty reply");

export default defineEval({
  description:
    "Morning briefing: an ordinary day of meetings and a newsletter, with no reminders or waiting coding sessions, gets no text at all.",
  tags: ["briefing"],
  async test(t) {
    const turn = await t.send(await googleBriefingMessage(quietDay));
    t.succeeded();
    t.calledTool("stay_silent");
    for (const tool of [
      "schedule_reminder",
      "cancel_reminder",
      "start_coding_session",
      "message_coding_session",
      "stop_coding_session",
      "merge_pull_request",
      "generate_speech",
      "list_events",
      "search_email",
    ]) {
      t.notCalledTool(tool);
    }
    t.check(turn.message ?? "", silent);
  },
});
