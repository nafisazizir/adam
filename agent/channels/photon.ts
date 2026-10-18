import { photonIMessageChannel } from "eve/channels/photon";

import { env } from "#lib/env.js";
import {
  claimHomeTarget,
  type HomeTarget,
  readHomeTargetState,
  rememberChannelPresence,
  rememberHomeTarget,
} from "#lib/home-target.js";
import { withInboundMediaNormalization } from "#lib/inbound-media.js";
import { resolveAttachmentIds, sentOverAnotherService, unreadableInbound } from "#lib/photon-inbound.js";
import {
  admitSender,
  type InboundSender,
  ownerAuth,
  ownerIssuer,
  ownerRecordLookup,
  type SenderAdmission,
} from "#lib/owner.js";
import { completedReply, deliverReply, otherSurfaceContext, signInMessage } from "#lib/reply.js";
import { currentTimeContext } from "#lib/time.js";

export const photonAdapterName = "imessage";
export const photonAuthenticator = "photon-imessage";

const ownerRecord = ownerRecordLookup(readHomeTargetState, ownerIssuer);

async function admit(sender: InboundSender): Promise<SenderAdmission> {
  const handles = env.OWNER_IMESSAGE_HANDLES;
  const admission = admitSender(sender, { handles, record: await ownerRecord.current() });
  const who = sender.id || "an unknown sender";
  const chat = sender.isDirect ? "direct" : "group";
  if (!admission.admitted) {
    console.warn(`[photon] ignored a message from ${who} in a ${chat} chat: ${admission.reason}`);
  }
  return admission;
}

async function claim(home: HomeTarget): Promise<boolean> {
  const who = home.owner.principalId;
  const claimed = await ownerRecord.claim(who, () => claimHomeTarget(home));
  console.warn(
    claimed
      ? `[photon] ${who} claimed ownership; no owner was recorded or configured`
      : `[photon] ignored a message from ${who}: the ownership claim was not written`,
  );
  return claimed;
}

const groupChatContext =
  "This message came from a group chat, so other people read your replies. Keep the user's " +
  "private details (health, work, money, anything from their accounts) out of it unless they " +
  "ask you to share them here.";

const surfaceContext = env.whatsapp ? [otherSurfaceContext("WhatsApp")] : [];

async function rememberHome(home: HomeTarget): Promise<void> {
  try {
    await rememberHomeTarget(home);
    await rememberChannelPresence(home.channel, { target: home.target, lastInboundAt: new Date().toISOString() });
  } catch (error) {
    console.warn("[photon] failed to remember home target", error);
  }
}

export default withInboundMediaNormalization(photonIMessageChannel({
  credentials: () => ({
    projectId: env.IMESSAGE_PROJECT_ID,
    projectSecret: env.IMESSAGE_PROJECT_SECRET,
  }),
  webhookSecret: env.IMESSAGE_WEBHOOK_SECRET,
  events: {
    // Sign-in only starts in the owner's direct chat (`signInFromOwnerDirectChat`); this re-checks
    // the thread before posting the link, since in a group anyone could follow it and connect their
    // own account in the owner's name. Asks the adapter because a rebuilt thread never claims a DM.
    async "authorization.required"(event, channel) {
      const text = signInMessage(event);
      if (!channel.thread || !text) return;

      if (!channel.bot.getAdapter(photonAdapterName).isDM(channel.thread.id)) {
        await channel.thread.post({
          markdown: `I need you to connect ${event.authorization?.displayName ?? event.name} first. Text me directly and ask again.`,
        });
        return;
      }

      await channel.thread.post({ markdown: text });
    },
    // Replaces the default text-only post so image links become real iMessage
    // attachments, audio a native voice note, and a reply lands as a few bubbles.
    // Streaming is off for this channel, so a turn is delivered once here.
    async "message.completed"(event, channel) {
      const reply = completedReply(event, channel.state);
      const thread = channel.thread;
      if (!reply || !thread) return;

      const adapter = channel.bot.getAdapter(photonAdapterName);
      await deliverReply(reply, {
        post: ({ text, files }) => thread.post({ markdown: text, files }),
        sendVoice: (voiceNote) =>
          adapter.sendVoice(thread.id, voiceNote.data, { mimeType: voiceNote.mimeType, name: voiceNote.filename }),
      });
    },
  },
  async onMessage(ctx, message) {
    if (message.author.isMe) return null;

    const isDirect = ctx.thread.isDM === true;
    const admission = await admit({
      id: message.author.userId,
      isDirect,
      service: sentOverAnotherService(message.raw) ? "sms-or-rcs" : "imessage",
    });
    if (!admission.admitted) return null;

    const owner = { issuer: ownerIssuer, principalId: admission.principalId };
    const home: HomeTarget = {
      channel: "photon",
      target: { threadId: message.threadId, adapterName: photonAdapterName },
      owner,
    };
    if (admission.claimed && !(await claim(home))) return null;

    try {
      await resolveAttachmentIds(message.raw, (ctx.thread.adapter as { app?: unknown }).app);
    } catch (error) {
      console.warn("[photon] failed to resolve attachment ids", error);
    }

    const unreadable = unreadableInbound(message);
    if (unreadable) console.warn("[photon:inbound.unreadable]", unreadable);

    if (admission.updatesHome && !admission.claimed) {
      ownerRecord.remember(owner.principalId);
      await rememberHome(home);
    }

    return {
      auth: ownerAuth(owner, {
        attributes: { thread_id: message.threadId, direct: isDirect ? "true" : "false" },
        authenticator: photonAuthenticator,
      }),
      context: [currentTimeContext(), ...surfaceContext, ...(isDirect ? [] : [groupChatContext])],
    };
  },
}));
