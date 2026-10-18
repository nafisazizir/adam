import type { RouteHandlerArgs, Session, TurnPolicy } from "eve/channels";
import type { SessionAuthContext } from "eve/context";

import photon, { photonAdapterName, photonAuthenticator } from "#channels/photon.js";
import { whatsapp, whatsappAdapterName, whatsappAuthenticator } from "#channels/whatsapp.js";
import { type ChannelPresence, homeChannels, type HomeOwner, type HomeTarget, readHomeTarget } from "#lib/home-target.js";
import { withinServiceWindow } from "#lib/whatsapp.js";

type To = RouteHandlerArgs["to"];

export interface DeliveryChannel {
  readonly name: string;
  targetFromAuth(auth: SessionAuthContext): Record<string, unknown> | null;
  // Whether a message started now still reaches the owner there, given when they last wrote.
  canReach(presence: ChannelPresence, now: number): boolean;
  deliver(args: {
    to: To;
    message: string;
    target: Record<string, unknown>;
    auth: SessionAuthContext;
    turnPolicy?: TurnPolicy;
  }): Promise<Session>;
}

type ThreadTarget = { threadId: string; adapterName: string };

function attribute(auth: SessionAuthContext, key: string): string | undefined {
  const value = auth.attributes[key];
  if (value == null) return undefined;
  return String(Array.isArray(value) ? value[0] : value);
}

function threadTarget(auth: SessionAuthContext, authenticator: string, adapterName: string): ThreadTarget | null {
  if (auth.authenticator !== authenticator) return null;
  const threadId = attribute(auth, "thread_id");
  return threadId ? { threadId, adapterName } : null;
}

const photonDelivery: DeliveryChannel = {
  name: "photon",
  targetFromAuth: (auth) => threadTarget(auth, photonAuthenticator, photonAdapterName),
  canReach: () => true,
  deliver({ to, message, target, auth, turnPolicy }) {
    return to(photon, target as ThreadTarget).send(message, { auth, turnPolicy });
  },
};

// Outside Meta's customer service window only pre-approved templates go through, so WhatsApp is
// reachable only for a while after the owner last wrote there.
const whatsappDelivery: DeliveryChannel = {
  name: "whatsapp",
  targetFromAuth: (auth) => threadTarget(auth, whatsappAuthenticator, whatsappAdapterName),
  canReach: (presence, now) => whatsapp !== null && withinServiceWindow(presence.lastInboundAt, now),
  deliver({ to, message, target, auth, turnPolicy }) {
    if (!whatsapp) throw new Error("WhatsApp is not configured");
    return to(whatsapp, target as ThreadTarget).send(message, { auth, turnPolicy });
  },
};

export const deliveryChannels: readonly DeliveryChannel[] = [photonDelivery, whatsappDelivery];

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

export function deliveryChannelByName(name: string): DeliveryChannel | undefined {
  return deliveryChannels.find((channel) => channel.name === name);
}

const lastInbound = (presence: ChannelPresence) =>
  presence.lastInboundAt ? Date.parse(presence.lastInboundAt) : Number.NEGATIVE_INFINITY;

// Adam speaks up where the owner is talking now: of the channels it can still reach them on, the
// one they last wrote from.
export function pickHomeDelivery(
  home: HomeTarget,
  now: number,
  channels: readonly DeliveryChannel[] = deliveryChannels,
): { channel: DeliveryChannel; target: Record<string, unknown> } | null {
  let best: { channel: DeliveryChannel; target: Record<string, unknown>; at: number } | null = null;
  for (const [name, presence] of Object.entries(homeChannels(home))) {
    const channel = channels.find((candidate) => candidate.name === name);
    if (!channel?.canReach(presence, now)) continue;
    const at = lastInbound(presence);
    if (best === null || at > best.at) best = { channel, target: presence.target, at };
  }
  return best && { channel: best.channel, target: best.target };
}

export interface OwnerDelivery {
  channel: DeliveryChannel;
  target: Record<string, unknown>;
  owner: HomeOwner;
}

export async function homeDelivery(now: number = Date.now()): Promise<OwnerDelivery | null> {
  const home = await readHomeTarget();
  if (!home) return null;

  const picked = pickHomeDelivery(home, now);
  return picked ? { ...picked, owner: home.owner } : null;
}

// Something that belongs to one surface, such as a call placed over WhatsApp, goes to the owner's
// thread there while it can still reach them, and otherwise wherever homeDelivery would send it.
export function pickDeliveryOn(
  name: string,
  home: HomeTarget,
  now: number,
  channels: readonly DeliveryChannel[] = deliveryChannels,
): { channel: DeliveryChannel; target: Record<string, unknown> } | null {
  const own = channels.filter((channel) => channel.name === name);
  return pickHomeDelivery(home, now, own) ?? pickHomeDelivery(home, now, channels);
}

export async function deliveryOn(name: string, now: number = Date.now()): Promise<OwnerDelivery | null> {
  const home = await readHomeTarget();
  if (!home) return null;

  const picked = pickDeliveryOn(name, home, now);
  return picked ? { ...picked, owner: home.owner } : null;
}
