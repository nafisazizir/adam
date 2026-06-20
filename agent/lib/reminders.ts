import { defineState } from "eve/context";

export interface ScheduledReminder {
  readonly id: string;
  readonly message: string;
  readonly fireAt: string;
}

export const scheduledReminders = defineState<ScheduledReminder[]>(
  "adam.reminders",
  () => [],
);
