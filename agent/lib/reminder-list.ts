export interface ScheduledReminder {
  readonly id: string;
  readonly message: string;
  readonly fireAt: string;
}

export interface StoredReminders {
  readonly reminders: ScheduledReminder[];
  readonly etag: string;
}

export class ReminderListConflict extends Error {}

export interface ReminderListStore {
  read(): Promise<StoredReminders | null>;
  write(reminders: ScheduledReminder[], expected: { etag: string } | "absent"): Promise<void>;
}

export type ReminderListRead =
  | { readonly status: "ok"; readonly reminders: ScheduledReminder[] }
  | { readonly status: "unavailable" };

const maxAttempts = 6;

async function update(
  store: ReminderListStore,
  change: (reminders: ScheduledReminder[]) => ScheduledReminder[],
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const current = await store.read();
    try {
      await store.write(change(current?.reminders ?? []), current ? { etag: current.etag } : "absent");
      return;
    } catch (error) {
      if (!(error instanceof ReminderListConflict) || attempt === maxAttempts) throw error;
    }
  }
}

// QStash is what fires a reminder; the list only backs list_reminders and cancel_reminder, so a
// store failure is logged and never fails the caller.
async function bestEffort(action: string, run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    console.warn(`[reminder-list] could not ${action}`, error);
    return false;
  }
}

export function recordReminder(store: ReminderListStore, reminder: ScheduledReminder): Promise<boolean> {
  return bestEffort("record a reminder", () =>
    update(store, (list) => [...list.filter((entry) => entry.id !== reminder.id), reminder]),
  );
}

export function forgetReminder(store: ReminderListStore, id: string): Promise<boolean> {
  return bestEffort("forget a reminder", () => update(store, (list) => list.filter((entry) => entry.id !== id)));
}

function isUpcoming(reminder: ScheduledReminder, now: number): boolean {
  return Date.parse(reminder.fireAt) > now;
}

export async function listUpcomingReminders(store: ReminderListStore, now: number): Promise<ReminderListRead> {
  let upcoming: ScheduledReminder[] = [];
  const read = await bestEffort("read the reminder list", async () => {
    upcoming = ((await store.read())?.reminders ?? []).filter((reminder) => isUpcoming(reminder, now));
  });
  if (!read) return { status: "unavailable" };

  await bestEffort("prune the reminder list", () =>
    update(store, (list) => list.filter((reminder) => isUpcoming(reminder, now))),
  );
  return { status: "ok", reminders: upcoming };
}
