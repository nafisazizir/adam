import { createMemoryState } from "@chat-adapter/state-memory";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import type { SessionAuthContext } from "eve/context";
import { defineChannel, GET, POST } from "eve/channels";
import { chatSdkChannel, messageToUserContent } from "eve/channels/chat-sdk";

import { blobClaimStore } from "#lib/claim-store.js";
import { releaseDay, tryClaimOnce } from "#lib/daily-claim.js";
import { env, whatsappPath } from "#lib/env.js";
import { readHomeTargetState, rememberChannelPresence } from "#lib/home-target.js";
import { admitSender, ownerAuth, ownerIssuer, ownerRecordLookup, type SenderAdmission } from "#lib/owner.js";
import { completedReply, deliverReply, otherSurfaceContext, signInMessage } from "#lib/reply.js";
import { currentTimeContext } from "#lib/time.js";
import { inboundMessageClaimKey, isBusinessScopedUserId, waIdToE164 } from "#lib/whatsapp.js";

export const whatsappAdapterName = "whatsapp";
export const whatsappAuthenticator = "whatsapp";

const ownerRecord = ownerRecordLookup(readHomeTargetState, ownerIssuer);

const surfaceContext = otherSurfaceContext("iMessage");

async function admit(userId: string): Promise<SenderAdmission> {
  const number = waIdToE164(userId);
  if (!number) {
    const why = isBusinessScopedUserId(userId)
      ? "WhatsApp sent only a username id, not a phone number. Adam knows the owner by number, " +
        "so WhatsApp has to share it with this business: message from an account without a username, or check Meta's username privacy settings"
      : "not a phone number";
    console.warn(`[whatsapp] ignored a message from ${userId || "an unknown sender"}: ${why}`);
    return { admitted: false, reason: why };
  }

  const admission = admitSender(
    { id: number, isDirect: true, service: "whatsapp" },
    {
      handles: env.OWNER_IMESSAGE_HANDLES,
      whatsappNumbers: env.OWNER_WHATSAPP_NUMBERS,
      record: await ownerRecord.current(),
    },
  );
  if (!admission.admitted) console.warn(`[whatsapp] ignored a message from ${number}: ${admission.reason}`);
  return admission;
}

// The Cloud API has no group chats, so every WhatsApp turn is the owner's direct chat.
function chatAuth(principalId: string, threadId: string): SessionAuthContext {
  return ownerAuth(
    { issuer: ownerIssuer, principalId },
    { authenticator: whatsappAuthenticator, attributes: { thread_id: threadId, direct: "true" } },
  );
}

// Meta retries a webhook it thinks failed, possibly onto another instance than the one that
// handled it, so a message is claimed across instances. A Blob outage must not cost the owner a
// message, so an unknown outcome handles it anyway.
async function claimInbound(messageId: string) {
  const attempt = await tryClaimOnce(blobClaimStore, inboundMessageClaimKey(messageId));
  if (attempt.status === "unavailable") {
    console.warn(`[whatsapp] could not check ${messageId} for a redelivery; handling it anyway`, attempt.error);
  }
  return attempt;
}

async function rememberPresence(threadId: string, sentAt: Date): Promise<void> {
  const at = Math.min(Number.isFinite(sentAt.getTime()) ? sentAt.getTime() : Date.now(), Date.now());
  try {
    await rememberChannelPresence("whatsapp", {
      target: { threadId, adapterName: whatsappAdapterName },
      lastInboundAt: new Date(at).toISOString(),
    });
  } catch (error) {
    console.warn("[whatsapp] failed to remember when the owner last wrote", error);
  }
}

function createWhatsAppChannel(credentials: NonNullable<typeof env.whatsapp>) {
  const { bot, channel, send } = chatSdkChannel({
    userName: "adam",
    adapters: { whatsapp: createWhatsAppAdapter({ ...credentials, userName: "adam" }) },
    state: createMemoryState(),
    concurrency: "concurrent",
    streaming: false,
    routes: { whatsapp: whatsappPath },
    // A button tap on a confirmation resumes the turn as whoever tapped it.
    async resolveInputAuth(event) {
      if (!event.thread) return null;
      const admission = await admit(event.user.userId);
      return admission.admitted ? chatAuth(admission.principalId, event.thread.id) : null;
    },
    events: {
      async "authorization.required"(event, channel) {
        const text = signInMessage(event);
        if (channel.thread && text) await channel.thread.post({ raw: text });
      },
      // Posted raw: Adam writes plain text, and the adapter's Markdown conversion would wrap
      // links in angle brackets and backslash-escape asterisks.
      async "message.completed"(event, channel) {
        const reply = completedReply(event, channel.state);
        const thread = channel.thread;
        if (!reply || !thread) return;

        await deliverReply(reply, {
          post: ({ text, files }) => thread.post({ raw: text, files }),
          sendVoice: (voiceNote) => thread.post({ raw: "", files: [voiceNote] }),
        });
      },
    },
  });

  bot.onDirectMessage(async (thread, message) => {
    if (message.author.isMe) return;

    const admission = await admit(message.author.userId);
    if (!admission.admitted) return;

    const attempt = await claimInbound(message.id);
    if (attempt.status === "taken") {
      console.log(`[whatsapp] skipped ${message.id}, already handled`);
      return;
    }

    await bot.getAdapter(whatsappAdapterName).markAsRead(thread.id, message.id).catch(() => {});
    await rememberPresence(thread.id, message.metadata.dateSent);

    try {
      await send(messageToUserContent(message), {
        thread,
        auth: chatAuth(admission.principalId, thread.id),
        context: [currentTimeContext(), surfaceContext],
      });
    } catch (error) {
      if (attempt.status === "claimed") await releaseDay(blobClaimStore, attempt.claim);
      throw error;
    }
  });

  return channel;
}

if (env.whatsappPartlyConfigured) {
  console.warn(
    "[whatsapp] disabled: set all of WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_VERIFY_TOKEN",
  );
}

// Without credentials the webhook still answers, so a misconfigured Meta app says why it fails.
function unconfiguredChannel() {
  const notConfigured = async () => new Response("WhatsApp is not configured", { status: 503 });
  return defineChannel({ routes: [GET(whatsappPath, notConfigured), POST(whatsappPath, notConfigured)] });
}

export const whatsapp = env.whatsapp ? createWhatsAppChannel(env.whatsapp) : null;

export default whatsapp ?? unconfiguredChannel();
