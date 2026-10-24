import type { RouteHandlerArgs, Session, TurnPolicy } from "eve/channels";
import type { SessionAuthContext } from "eve/context";

import photon, { photonAdapterName, photonAuthenticator } from "#channels/photon.js";
import { readHomeTarget, type HomeOwner } from "#lib/home-target.js";

type To = RouteHandlerArgs["to"];

export interface DeliveryChannel {
  readonly name: string;
  targetFromAuth(auth: SessionAuthContext): Record<string, unknown> | null;
  deliver(args: {
    to: To;
    message: string;
    target: Record<string, unknown>;
    auth: SessionAuthContext;
    turnPolicy?: TurnPolicy;
  }): Promise<Session>;
}

function attribute(auth: SessionAuthContext, key: string): string | undefined {
  const value = auth.attributes[key];
  if (value == null) return undefined;
  return String(Array.isArray(value) ? value[0] : value);
}

const photonDelivery: DeliveryChannel = {
  name: "photon",
  targetFromAuth(auth) {
    if (auth.authenticator !== photonAuthenticator) return null;
    const threadId = attribute(auth, "thread_id");
    return threadId ? { threadId, adapterName: photonAdapterName } : null;
  },
  deliver({ to, message, target, auth, turnPolicy }) {
    return to(photon, target as { threadId: string; adapterName: string }).send(message, {
      auth,
      turnPolicy,
    });
  },
};

export const deliveryChannels: readonly DeliveryChannel[] = [photonDelivery];

export function deliveryChannelForAuth(
  auth: SessionAuthContext,
): { channel: DeliveryChannel; target: Record<string, unknown> } | null {
  for (const channel of deliveryChannels) {
    const target = channel.targetFromAuth(auth);
    if (target) return { channel, target };
  }
  return null;
}

// Only the owner reaches a chat turn (`admitSender`), and background turns (debriefs, coding updates,
// the briefing, reminders) never resolve to a delivery channel. Gate on isOwnerChat when an action
// needs the owner's say-so in chat, such as a confirmation; gate on isOwnerDirectChat when it hands
// out a link that grants access to the owner's accounts (a sign-in or consent link), since in a group
// anyone could follow it first.
export function isOwnerChat(auth: SessionAuthContext | null | undefined): auth is SessionAuthContext {
  return auth != null && deliveryChannelForAuth(auth) !== null;
}

export function isOwnerDirectChat(auth: SessionAuthContext | null | undefined): boolean {
  return isOwnerChat(auth) && attribute(auth, "direct") === "true";
}

// For an action behind a ctx.ask confirmation: a prompt parked in a background turn would hold the
// owner's thread, since only that turn's caller can answer it.
export function ownerChatRefusal(action: string, auth: SessionAuthContext | null | undefined): string | null {
  if (isOwnerChat(auth)) return null;
  return `${action} needs the user's go-ahead in chat, and this turn did not come from them. Ask them in chat, and do it when they say so.`;
}

export function deliveryChannelByName(name: string): DeliveryChannel | undefined {
  return deliveryChannels.find((channel) => channel.name === name);
}

export async function homeDelivery(): Promise<{
  channel: DeliveryChannel;
  target: Record<string, unknown>;
  owner: HomeOwner;
} | null> {
  const home = await readHomeTarget();
  if (!home) return null;

  const channel = deliveryChannelByName(home.channel);
  return channel ? { channel, target: home.target, owner: home.owner } : null;
}
