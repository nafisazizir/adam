import type { RouteHandlerArgs } from "eve/channels";
import type { SessionAuthContext } from "eve/context";

import photon, { photonAdapterName, photonAuthenticator } from "#channels/photon.js";
import telegram from "#channels/telegram.js";

type To = RouteHandlerArgs["to"];

export interface DeliveryChannel {
  readonly name: string;
  targetFromAuth(auth: SessionAuthContext): Record<string, unknown> | null;
  deliver(args: {
    to: To;
    message: string;
    target: Record<string, unknown>;
    auth: SessionAuthContext;
  }): Promise<unknown>;
}

function attribute(auth: SessionAuthContext, key: string): string | undefined {
  const value = auth.attributes[key];
  if (value == null) return undefined;
  return String(Array.isArray(value) ? value[0] : value);
}

const telegramDelivery: DeliveryChannel = {
  name: "telegram",
  targetFromAuth(auth) {
    if (auth.authenticator !== "telegram-webhook") return null;
    const chatId = attribute(auth, "chat_id");
    return chatId ? { chatId } : null;
  },
  deliver({ to, message, target, auth }) {
    return to(telegram, target as { chatId: string }).send(message, { auth });
  },
};

const photonDelivery: DeliveryChannel = {
  name: "photon",
  targetFromAuth(auth) {
    if (auth.authenticator !== photonAuthenticator) return null;
    const threadId = attribute(auth, "thread_id");
    return threadId ? { threadId, adapterName: photonAdapterName } : null;
  },
  deliver({ to, message, target, auth }) {
    return to(photon, target as { threadId: string; adapterName: string }).send(message, { auth });
  },
};

export const deliveryChannels: readonly DeliveryChannel[] = [telegramDelivery, photonDelivery];

export function deliveryChannelForAuth(
  auth: SessionAuthContext,
): { channel: DeliveryChannel; target: Record<string, unknown> } | null {
  for (const channel of deliveryChannels) {
    const target = channel.targetFromAuth(auth);
    if (target) return { channel, target };
  }
  return null;
}

export function deliveryChannelByName(name: string): DeliveryChannel | undefined {
  return deliveryChannels.find((channel) => channel.name === name);
}
