import { photonIMessageChannel } from "eve/channels/photon";

import { releaseAssets } from "#lib/assets.js";
import { env } from "#lib/env.js";
import { readHomeTargetState, rememberHomeTarget } from "#lib/home-target.js";
import { withInboundMediaNormalization } from "#lib/inbound-media.js";
import { resolveAttachmentIds, sentOverIMessage, unreadableInbound } from "#lib/photon-inbound.js";
import { renderOutbound, splitBubbles } from "#lib/outbound.js";
import {
  admitSender,
  type InboundSender,
  ownerAuth,
  ownerRecordLookup,
  type SenderAdmission,
} from "#lib/owner.js";
import { currentTimeContext } from "#lib/time.js";

export const photonAdapterName = "imessage";
export const photonAuthenticator = "photon-imessage";

const BUBBLE_GAP_MS = 400;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ownerRecord = ownerRecordLookup(readHomeTargetState, photonAuthenticator);

async function admit(sender: InboundSender): Promise<SenderAdmission> {
  const handles = env.OWNER_IMESSAGE_HANDLES;
  const admission = admitSender(sender, { handles, record: await ownerRecord.current() });
  const who = sender.id || "an unknown sender";
  const chat = sender.isDirect ? "direct" : "group";
  if (!admission.admitted) {
    console.warn(`[photon] ignored a message from ${who} in a ${chat} chat: ${admission.reason}`);
  } else if (admission.claimed) {
    console.warn(`[photon] ${who} claimed ownership; no owner was recorded or configured`);
  }
  return admission;
}

const groupChatContext =
  "This message came from a group chat, so other people read your replies. Keep the user's " +
  "private details (health, work, money, anything from their accounts) out of it unless they " +
  "ask you to share them here.";

function firstNonEmptyLine(message: string): string | null {
  for (const line of message.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

export default withInboundMediaNormalization(photonIMessageChannel({
  credentials: () => ({
    projectId: env.IMESSAGE_PROJECT_ID,
    projectSecret: env.IMESSAGE_PROJECT_SECRET,
  }),
  webhookSecret: env.IMESSAGE_WEBHOOK_SECRET,
  events: {
    // Only the owner gets through, so a direct thread is theirs alone; in a group anyone could
    // follow the link and connect their own account in the owner's name. Asks the adapter because
    // a thread rebuilt for a background delivery always claims it is not a DM.
    async "authorization.required"(event, channel) {
      const { url, instructions, userCode, displayName } = event.authorization ?? {};
      if (!channel.thread || (!url && !instructions)) return;

      if (!channel.bot.getAdapter(photonAdapterName).isDM(channel.thread.id)) {
        await channel.thread.post({
          markdown: `I need you to connect ${displayName ?? event.name} first. Text me directly and ask again.`,
        });
        return;
      }

      const lines = [
        `I need you to connect ${displayName ?? event.name} before I can carry on.`,
        url,
        userCode && `Code: ${userCode}`,
        instructions,
      ].filter(Boolean);
      await channel.thread.post({ markdown: lines.join("\n\n") });
    },
    // Replaces the default text-only post so image links become real iMessage
    // attachments and a reply lands as a few bubbles. Streaming is off for this
    // channel, so a turn is delivered once here.
    async "message.completed"(event, channel) {
      if (event.finishReason === "tool-calls") {
        channel.state.pendingToolCallMessage = event.message
          ? firstNonEmptyLine(event.message)
          : null;
        return;
      }

      channel.state.pendingToolCallMessage = null;
      if (!event.message || !channel.thread) return;

      let posted = 0;
      for (const bubble of splitBubbles(event.message)) {
        const { text, files, sources } = await renderOutbound(bubble);
        const voiceNotes = files.filter((file) => file.mimeType.startsWith("audio/"));
        const attachments = files.filter((file) => !file.mimeType.startsWith("audio/"));
        if (text.length === 0 && attachments.length === 0 && voiceNotes.length === 0) continue;

        if (text.length > 0 || attachments.length > 0) {
          if (posted > 0) await pause(BUBBLE_GAP_MS);
          await channel.thread.post({ markdown: text, files: attachments });
          posted += 1;
        }

        const adapter = channel.bot.getAdapter(photonAdapterName);
        for (const voiceNote of voiceNotes) {
          if (posted > 0) await pause(BUBBLE_GAP_MS);
          await adapter.sendVoice(channel.thread.id, voiceNote.data, {
            mimeType: voiceNote.mimeType,
            name: voiceNote.filename,
          });
          posted += 1;
        }

        // iMessage holds its own copy now, so nothing we generated stays hosted.
        await releaseAssets(sources).catch(() => {});
      }
    },
  },
  async onMessage(ctx, message) {
    if (message.author.isMe) return null;

    const isDirect = ctx.thread.isDM === true;
    const admission = await admit({
      id: message.author.userId,
      isDirect,
      isIMessage: sentOverIMessage(message.raw),
    });
    if (!admission.admitted) return null;

    try {
      await resolveAttachmentIds(message.raw, (ctx.thread.adapter as { app?: unknown }).app);
    } catch (error) {
      console.warn("[photon] failed to resolve attachment ids", error);
    }

    const unreadable = unreadableInbound(message);
    if (unreadable) console.warn("[photon:inbound.unreadable]", unreadable);

    const owner = { issuer: photonAuthenticator, principalId: admission.principalId };
    if (admission.updatesHome) {
      ownerRecord.remember(owner.principalId);
      try {
        await rememberHomeTarget({
          channel: "photon",
          target: { threadId: message.threadId, adapterName: photonAdapterName },
          owner,
        });
      } catch (error) {
        console.warn("[photon] failed to remember home target", error);
      }
    }

    return {
      auth: ownerAuth(owner, {
        attributes: { thread_id: message.threadId },
        authenticator: photonAuthenticator,
      }),
      context: isDirect ? [currentTimeContext()] : [currentTimeContext(), groupChatContext],
    };
  },
}));
