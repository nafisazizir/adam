import { callEndedMessage, callRequestMessage, callStartedMessage } from "#lib/calls.js";
import { currentTimeContext } from "#lib/time.js";
import type { CallEnded } from "#lib/voice.js";

export const requestNonce = "eval-call-request-0001";

export function callRequest(request: string): string {
  return [currentTimeContext(), "", callRequestMessage(request, requestNonce)].join("\n");
}

const endedCall: CallEnded = {
  conversationId: "conv_eval_0001",
  direction: "inbound",
  callerNumber: "+61412345678",
  calledNumber: "+61290000000",
  summary: "The user called to ask how many weeks are left until Christmas; Adam said about ten. They chatted briefly and hung up.",
  transcript: [
    { speaker: "adam", text: "hey, it's Adam" },
    { speaker: "caller", text: "how many weeks till christmas?" },
    { speaker: "adam", text: "about ten weeks. better start on the gift list." },
    { speaker: "caller", text: "ha, fair. ok thanks, bye" },
    { speaker: "adam", text: "bye!" },
  ],
  startedAt: "2026-10-26T04:12:00.000Z",
  durationSecs: 48,
};

export function callEnded(): string {
  return [currentTimeContext(), "", callEndedMessage(endedCall, { transcriptSaved: true })].join("\n");
}

export function callStarted(): string {
  return [currentTimeContext(), "", callStartedMessage({ conversationId: "conv_eval_0002" })].join("\n");
}
