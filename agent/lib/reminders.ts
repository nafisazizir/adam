import { defineState, type SessionAuthContext } from "eve/context";

import type { HomeOwner } from "#lib/home-target.js";
import { ownerAuth } from "#lib/owner.js";

export const remindersAuthenticator = "reminders";

export interface ScheduledReminder {
  readonly id: string;
  readonly message: string;
  readonly fireAt: string;
}

export const scheduledReminders = defineState<ScheduledReminder[]>(
  "adam.reminders",
  () => [],
);

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
