import type { SessionAuthContext } from "eve/context";

import { callOwnerTool } from "#lib/calls.js";
import type { HomeOwner } from "#lib/home-target.js";
import { ownerAuth } from "#lib/owner.js";

export const remindersAuthenticator = "reminders";

export function reminderAuth(owner: HomeOwner | null, messageId: string | null, ring = false): SessionAuthContext {
  if (owner) {
    return ownerAuth(owner, {
      authenticator: remindersAuthenticator,
      attributes: { ...(messageId && { message_id: messageId }), ...(ring && { ring: "true" }) },
    });
  }
  return {
    attributes: {},
    authenticator: "qstash",
    principalId: "reminders",
    principalType: "service",
  };
}

// Only a reminder the owner asked to be rung for carries `ring`, and its signed QStash payload is
// the only way to get one.
export function isRingingReminderTurn(auth: SessionAuthContext | null | undefined): boolean {
  return (
    auth?.authenticator === remindersAuthenticator && auth.principalType === "user" && auth.attributes["ring"] === "true"
  );
}

export function dueReminderMessage(message: string, ring: boolean): string {
  const due = `A reminder you scheduled earlier is now due: ${message}`;
  if (!ring) return due;
  return `${due}\n\nThey asked you to ring them for this one: call ${callOwnerTool} with what to say when they pick up.`;
}

export interface ReminderDestination {
  readonly channel: string;
  readonly target: Record<string, unknown>;
}

// A reminder now runs as the owner with memory, so one set from a group chat must not post there.
export function reminderDestination(
  requested: ReminderDestination,
  home: (ReminderDestination & { readonly owner: HomeOwner }) | null,
): ReminderDestination {
  return home ? { channel: home.channel, target: home.target } : requested;
}

export function isMissingReminderError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;
}
