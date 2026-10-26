import { randomUUID } from "node:crypto";

import { defineChannel, POST, type Session } from "eve/channels";

import {
  afterCallAuth,
  awaitCallReply,
  callBriefing,
  callEndedMessage,
  callMissedMessage,
  type CallReply,
  callRequestMessage,
  callStartedMessage,
  declinedCallBriefing,
  isOwnerCaller,
  isOwnerOnCall,
  liveCallAuth,
  otherParty,
  spokenReply,
} from "#lib/calls.js";
import { blobCallTranscriptStore } from "#lib/call-transcript-store.js";
import { keepCallTranscript } from "#lib/call-transcripts.js";
import { blobClaimStore } from "#lib/claim-store.js";
import { claimOnce, releaseDay } from "#lib/daily-claim.js";
import { homeDelivery } from "#lib/delivery.js";
import { callsAskPath, callsEndedPath, callsStartPath, env } from "#lib/env.js";
import { knownOwner } from "#lib/known-owner.js";
import { parseJson } from "#lib/qstash.js";
import { currentTimeContext, formatUserDateTime } from "#lib/time.js";
import {
  callReplyResponse,
  callStartResponse,
  hasCallsSecret,
  hasValidCallEndedSignature,
  parseCallEnded,
  parseCallRequest,
  parseCallStart,
} from "#lib/voice.js";
import { postCallWebhookSecret } from "#lib/voice-agent-store.js";

// The voice tool waits 30 seconds; answering sooner leaves room for the voice agent to speak.
const replyDeadlineMs = 25_000;

const notConfigured = () => Response.json({ ok: false, error: "calls_not_configured" }, { status: 503 });
const unauthorized = () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
const invalidPayload = () => Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });

function describe(callerNumber: string | null): string {
  return callerNumber ?? "an unknown caller";
}

function claimKey(conversationId: string): string {
  return `call-ended-${conversationId.replace(/[^\w-]/gu, "_")}`;
}

// The production build's voice agent sync creates the post-call webhook and keeps its secret.
async function postCallSecretOrNull(): Promise<string | null> {
  try {
    return await postCallWebhookSecret();
  } catch (error) {
    console.warn("[calls] could not read the post-call webhook secret", error);
    return null;
  }
}

async function homeDeliveryOrNull() {
  try {
    return await homeDelivery();
  } catch (error) {
    console.warn("[calls] could not read the home target", error);
    return null;
  }
}

function withTime(message: string): string {
  return [currentTimeContext(), "", message].join("\n");
}

export default defineChannel({
  routes: [
    POST(callsStartPath, async (request, { to, waitUntil }) => {
      const secret = env.CALLS_TOOL_SECRET;
      if (!secret) return notConfigured();
      if (!hasCallsSecret(request, secret)) return unauthorized();

      const start = parseCallStart(parseJson(await request.text()));
      if (!start) return invalidPayload();

      const localTime = formatUserDateTime(new Date());
      if (!isOwnerCaller(start.callerNumber, await knownOwner())) {
        console.warn(`[calls] declined a call from ${describe(start.callerNumber)}; not the owner`);
        return Response.json(callStartResponse(declinedCallBriefing(localTime)));
      }

      const home = await homeDeliveryOrNull();
      if (home) {
        const call = { conversationId: start.conversationId ?? "unknown" };
        waitUntil(
          home.channel
            .deliver({
              to,
              message: withTime(callStartedMessage(call)),
              target: home.target,
              auth: afterCallAuth(home.owner, call),
              turnPolicy: "queue",
            })
            .catch((error) => console.error("[calls] failed to note a started call", error)),
        );
      }
      return Response.json(callStartResponse(callBriefing(localTime)));
    }),

    POST(callsAskPath, async (request, { to, waitUntil }) => {
      const deadline = Date.now() + replyDeadlineMs;
      const secret = env.CALLS_TOOL_SECRET;
      if (!secret) return notConfigured();
      if (!hasCallsSecret(request, secret)) return unauthorized();

      const ask = parseCallRequest(parseJson(await request.text()));
      if (!ask) return invalidPayload();

      if (!isOwnerOnCall(ask, await knownOwner())) {
        console.warn(`[calls] refused a request on a call with ${describe(otherParty(ask))}; not the owner`);
        return Response.json({ ok: false, error: "not_owner" }, { status: 403 });
      }
      const home = await homeDeliveryOrNull();
      if (!home) {
        console.warn("[calls] no home delivery target is stored");
        return Response.json(callReplyResponse("I can't reach my messages right now. Text me instead."));
      }

      const { channel, target, owner } = home;
      const call = { conversationId: ask.conversationId };
      const nonce = randomUUID();
      let session: Session;
      try {
        session = await channel.deliver({
          to,
          message: withTime(callRequestMessage(ask.request, nonce)),
          target,
          auth: liveCallAuth(owner, call, deadline),
          turnPolicy: "queue",
        });
      } catch (error) {
        console.error(`[calls] failed to deliver a request for ${ask.conversationId}`, error);
        return Response.json(callReplyResponse(spokenReply({ kind: "failed" })));
      }

      let reply: CallReply | null = null;
      try {
        reply = await awaitCallReply(session, nonce, deadline);
      } catch (error) {
        console.error(`[calls] lost the session stream for ${ask.conversationId}`, error);
      }

      if (reply === null) {
        console.warn(`[calls] no reply within the deadline for ${ask.conversationId}`);
        waitUntil(
          channel
            .deliver({
              to,
              message: withTime(callMissedMessage(nonce)),
              target,
              auth: afterCallAuth(owner, call),
              turnPolicy: "queue",
            })
            .catch((error) => console.error("[calls] failed to deliver a missed reply note", error)),
        );
      }
      return Response.json(callReplyResponse(spokenReply(reply)));
    }),

    POST(callsEndedPath, async (request, { to }) => {
      const secret = await postCallSecretOrNull();
      if (!secret) return notConfigured();

      const body = await request.text();
      if (!hasValidCallEndedSignature(request, body, secret)) return unauthorized();

      const parsed = parseCallEnded(parseJson(body));
      if (!parsed.ok) {
        return parsed.reason === "ignored" ? Response.json({ ok: true, ignored: "event_type" }) : invalidPayload();
      }

      const { ended } = parsed;
      if (!isOwnerOnCall(ended, await knownOwner())) {
        console.warn(`[calls] skipping the summary of a call with ${describe(otherParty(ended))}`);
        return Response.json({ ok: true, ignored: "not_owner" });
      }
      const home = await homeDeliveryOrNull();
      if (!home) {
        console.warn("[calls] skipping a call summary; no home delivery target is stored");
        return Response.json({ ok: true, ignored: "no_home_target" });
      }

      // Retries and replays of a signed payload carry the same conversation id.
      const claim = await claimOnce(blobClaimStore, claimKey(ended.conversationId));
      if (!claim) {
        console.log(`[calls] skipping the summary of ${ended.conversationId}: already claimed, or the claim failed`);
        return Response.json({ ok: true, ignored: "not_claimed" });
      }

      const transcriptSaved = await keepCallTranscript(blobCallTranscriptStore, ended);
      try {
        await home.channel.deliver({
          to,
          message: withTime(callEndedMessage(ended, { transcriptSaved })),
          target: home.target,
          auth: afterCallAuth(home.owner, { conversationId: ended.conversationId }),
          turnPolicy: "queue",
        });
      } catch (error) {
        console.error(`[calls] failed to deliver the summary of ${ended.conversationId}`, error);
        await releaseDay(blobClaimStore, claim);
        return Response.json({ ok: false, error: "delivery_failed" }, { status: 500 });
      }

      console.log(`[calls] delivered the summary of ${ended.conversationId}`);
      return Response.json({ ok: true });
    }),
  ],
});
