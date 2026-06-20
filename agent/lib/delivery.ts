import type { RouteHandlerArgs } from "eve/channels";
import type { SessionAuthContext } from "eve/context";

import telegram from "#channels/telegram.js";

type Receive = RouteHandlerArgs["receive"];

export interface DeliveryChannel {
  readonly name: string;
  targetFromAuth(auth: SessionAuthContext): Record<string, unknown> | null;
  deliver(args: {
    receive: Receive;
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
  deliver({ receive, message, target, auth }) {
    return receive(telegram, { message, target: target as { chatId: string }, auth });
  },
};

export const deliveryChannels: readonly DeliveryChannel[] = [telegramDelivery];

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
