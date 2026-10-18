import type { SessionAuthContext } from "eve/context";

import type { HomeOwner } from "#lib/home-target.js";
import { ownerAuth } from "#lib/owner.js";

export const remindersAuthenticator = "reminders";

export function reminderAuth(owner: HomeOwner | null, messageId: string | null): SessionAuthContext {
  if (owner) {
    return ownerAuth(owner, {
      authenticator: remindersAuthenticator,
      attributes: messageId ? { message_id: messageId } : {},
    });
  }
  return {
    attributes: {},
    authenticator: "qstash",
    principalId: "reminders",
    principalType: "service",
  };
}

export interface ReminderDestination {
  readonly channel: string;
  readonly target: Record<string, unknown>;
}

// A reminder runs as the owner with memory, so one set from a group chat must not post there, and
// it lands wherever `homeDelivery` can reach the owner when it fires: a reminder set on WhatsApp
// comes back there while its window is open, otherwise on iMessage.
export function reminderDestination(
  requested: ReminderDestination,
  home: ReminderDestination | null,
): ReminderDestination {
  return home ? { channel: home.channel, target: home.target } : requested;
}

export function isMissingReminderError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;
}
