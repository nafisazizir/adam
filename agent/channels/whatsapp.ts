import { createMemoryState } from "@chat-adapter/state-memory";
import { createWhatsAppAdapter, WhatsAppApiError } from "@chat-adapter/whatsapp";
import type { SessionAuthContext } from "eve/context";
import { defineChannel, GET, POST } from "eve/channels";
import { chatSdkChannel, messageToUserContent } from "eve/channels/chat-sdk";

import { env, whatsappPath } from "#lib/env.js";
import { readHomeTargetState, rememberChannelPresence, rememberWithinBudget } from "#lib/home-target.js";
import { admitSender, ownerAuth, ownerIssuer, ownerRecordLookup, type SenderAdmission } from "#lib/owner.js";
import { completedReply, deliverReply, otherSurfaceContext, signInMessage } from "#lib/reply.js";
import { currentTimeContext } from "#lib/time.js";
import {
  isBusinessScopedUserId,
  normalizeOwnerNumbers,
  OUTSIDE_SERVICE_WINDOW,
  waIdToE164,
} from "#lib/whatsapp.js";

export const whatsappAdapterName = "whatsapp";
export const whatsappAuthenticator = "whatsapp";

const ownerRecord = ownerRecordLookup(readHomeTargetState, ownerIssuer);

const surfaceContext = otherSurfaceContext("iMessage");

const ownerWhatsAppNumbers = normalizeOwnerNumbers(env.OWNER_WHATSAPP_NUMBERS);

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
      whatsappNumbers: ownerWhatsAppNumbers,
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

function rememberPresence(threadId: string, sentAt: Date): Promise<void> {
  const at = Math.min(Number.isFinite(sentAt.getTime()) ? sentAt.getTime() : Date.now(), Date.now());
  return rememberWithinBudget("whatsapp", () =>
    rememberChannelPresence("whatsapp", {
      target: { threadId, adapterName: whatsappAdapterName },
      lastInboundAt: new Date(at).toISOString(),
    }),
  );
}

// `homeDelivery` keeps a margin before the window closes, so this only catches a turn that ran
// past it; the reply is lost, which the log says plainly.
function isOutsideServiceWindow(error: unknown): boolean {
  return error instanceof WhatsAppApiError && error.errorCode === OUTSIDE_SERVICE_WINDOW;
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

        try {
          await deliverReply(reply, {
            post: ({ text, files }) => thread.post({ raw: text, files }),
            sendVoice: (voiceNote) => thread.post({ raw: "", files: [voiceNote] }),
          });
        } catch (error) {
          if (!isOutsideServiceWindow(error)) throw error;
          console.error("[whatsapp] window closed: Meta refused the reply, so it was not delivered", error);
        }
      },
    },
  });

  bot.onDirectMessage(async (thread, message) => {
    if (message.author.isMe) return;

    const admission = await admit(message.author.userId);
    if (!admission.admitted) return;

    await bot.getAdapter(whatsappAdapterName).markAsRead(thread.id, message.id).catch(() => {});
    await rememberPresence(thread.id, message.metadata.dateSent);

    await send(messageToUserContent(message), {
      thread,
      auth: chatAuth(admission.principalId, thread.id),
      context: [currentTimeContext(), surfaceContext],
    });
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
