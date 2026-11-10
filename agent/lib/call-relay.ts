import { randomUUID } from "node:crypto";

import type { RouteHandlerArgs, Session } from "eve/channels";

import {
  afterCallAuth,
  awaitCallReply,
  callEndedMessage,
  callMissedMessage,
  type CallRef,
  type CallReply,
  callRequestMessage,
  callStartedMessage,
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
import { knownOwner } from "#lib/known-owner.js";
import { currentTimeContext } from "#lib/time.js";
import type { CallEnded, CallRequest } from "#lib/voice.js";

// Every voice vendor's front end hands calls to these, so each call lands in the owner's one thread.

export type RelayArgs = Pick<RouteHandlerArgs, "to" | "waitUntil">;

export type RelayedEnd =
  | { readonly status: 200; readonly body: { ok: true; ignored?: string } }
  | { readonly status: 500; readonly body: { ok: false; error: "delivery_failed" } };

export type RelayedAsk = { readonly ok: true; readonly speech: string } | { readonly ok: false; readonly error: "not_owner" };

// The voice tool waits 30 seconds; answering sooner leaves room for the voice agent to speak.
const replyDeadlineMs = 25_000;

export function describeCaller(callerNumber: string | null): string {
  return callerNumber ?? "an unknown caller";
}

function claimKey(conversationId: string): string {
  return `call-ended-${conversationId.replace(/[^\w-]/gu, "_")}`;
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

export async function noteCallStarted(call: CallRef, { to, waitUntil }: RelayArgs): Promise<void> {
  const home = await homeDeliveryOrNull();
  if (!home) return;
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

export async function relayCallRequest(ask: CallRequest, { to, waitUntil }: RelayArgs): Promise<RelayedAsk> {
  const deadline = Date.now() + replyDeadlineMs;
  if (!isOwnerOnCall(ask, await knownOwner())) {
    console.warn(`[calls] refused a request on a call with ${describeCaller(otherParty(ask))}; not the owner`);
    return { ok: false, error: "not_owner" };
  }
  const home = await homeDeliveryOrNull();
  if (!home) {
    console.warn("[calls] no home delivery target is stored");
    return { ok: true, speech: "I can't reach my messages right now. Text me instead." };
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
    return { ok: true, speech: spokenReply({ kind: "failed" }) };
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
  return { ok: true, speech: spokenReply(reply) };
}

export async function relayCallEnded(ended: CallEnded, { to }: Pick<RelayArgs, "to">): Promise<RelayedEnd> {
  if (!isOwnerOnCall(ended, await knownOwner())) {
    console.warn(`[calls] skipping the summary of a call with ${describeCaller(otherParty(ended))}`);
    return { status: 200, body: { ok: true, ignored: "not_owner" } };
  }
  const home = await homeDeliveryOrNull();
  if (!home) {
    console.warn("[calls] skipping a call summary; no home delivery target is stored");
    return { status: 200, body: { ok: true, ignored: "no_home_target" } };
  }

  // Retries and replays of a delivered report carry the same conversation id.
  const claim = await claimOnce(blobClaimStore, claimKey(ended.conversationId));
  if (!claim) {
    console.log(`[calls] skipping the summary of ${ended.conversationId}: already claimed, or the claim failed`);
    return { status: 200, body: { ok: true, ignored: "not_claimed" } };
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
    return { status: 500, body: { ok: false, error: "delivery_failed" } };
  }

  console.log(`[calls] delivered the summary of ${ended.conversationId}`);
  return { status: 200, body: { ok: true } };
}
