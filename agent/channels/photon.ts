import { photonIMessageChannel } from "eve/channels/photon";

import { releaseAssets } from "#lib/assets.js";
import { env } from "#lib/env.js";
import { renderOutbound, splitBubbles } from "#lib/outbound.js";
import { currentTimeContext } from "#lib/time.js";

export const photonAdapterName = "imessage";
export const photonAuthenticator = "photon-imessage";

const BUBBLE_GAP_MS = 400;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function firstNonEmptyLine(message: string): string | null {
  for (const line of message.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

export default photonIMessageChannel({
  credentials: () => ({
    projectId: env.IMESSAGE_PROJECT_ID,
    projectSecret: env.IMESSAGE_PROJECT_SECRET,
  }),
  webhookSecret: env.IMESSAGE_WEBHOOK_SECRET,
  events: {
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
        if (text.length === 0 && files.length === 0) continue;

        if (posted > 0) await pause(BUBBLE_GAP_MS);
        await channel.thread.post({ markdown: text, files });
        posted += 1;
        // iMessage holds its own copy now, so nothing we generated stays hosted.
        await releaseAssets(sources).catch(() => {});
      }
    },
  },
  onMessage(_ctx, message) {
    if (message.author.isMe) return null;

    return {
      auth: {
        attributes: { thread_id: message.threadId },
        authenticator: photonAuthenticator,
        principalId: message.author.userId,
        principalType: "user",
      },
      context: [currentTimeContext()],
    };
  },
});
