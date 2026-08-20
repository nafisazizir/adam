import { photonIMessageChannel } from "eve/channels/photon";

import { env } from "#lib/env.js";
import { renderOutbound } from "#lib/outbound.js";
import { currentTimeContext } from "#lib/time.js";

export const photonAdapterName = "imessage";
export const photonAuthenticator = "photon-imessage";

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
    // attachments. Streaming is off for this channel, so a turn posts once here.
    async "message.completed"(event, channel) {
      if (event.finishReason === "tool-calls") {
        channel.state.pendingToolCallMessage = event.message
          ? firstNonEmptyLine(event.message)
          : null;
        return;
      }

      channel.state.pendingToolCallMessage = null;
      if (!event.message || !channel.thread) return;

      const { text, files } = await renderOutbound(event.message);
      if (text.length === 0 && files.length === 0) return;

      await channel.thread.post({ markdown: text, files });
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
