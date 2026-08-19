import { photonIMessageChannel } from "eve/channels/photon";

import { env } from "#lib/env.js";
import { currentTimeContext } from "#lib/time.js";

export const photonAdapterName = "imessage";
export const photonAuthenticator = "photon-imessage";

export default photonIMessageChannel({
  credentials: () => ({
    projectId: env.IMESSAGE_PROJECT_ID,
    projectSecret: env.IMESSAGE_PROJECT_SECRET,
  }),
  webhookSecret: env.IMESSAGE_WEBHOOK_SECRET,
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
