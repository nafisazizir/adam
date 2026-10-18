import assert from "node:assert/strict";
import { test } from "node:test";

import {
  forgetReminder,
  forgetReminderWithin,
  parseReminderDocument,
  listUpcomingReminders,
  recordReminder,
  ReminderListConflict,
  type ReminderListStore,
  type ScheduledReminder,
} from "#lib/reminder-list.js";

function fakeStore(options: { failReads?: boolean } = {}) {
  let version = 0;
  let reminders: ScheduledReminder[] | null = null;
  const store: ReminderListStore & { writes: number; snapshot(): ScheduledReminder[] } = {
    writes: 0,
    snapshot: () => reminders ?? [],
    async read() {
      if (options.failReads) throw new Error("blob down");
      await Promise.resolve();
      return reminders ? { reminders: [...reminders], etag: String(version) } : null;
    },
    async write(next, expected) {
      await Promise.resolve();
      const current = reminders ? String(version) : "absent";
      if (current !== (expected === "absent" ? "absent" : expected.etag)) throw new ReminderListConflict("stale");
      reminders = next;
      version += 1;
      store.writes += 1;
    },
  };
  return store;
}

const now = Date.parse("2026-10-18T10:00:00Z");
const soon = (id: string): ScheduledReminder => ({ id, message: `m-${id}`, fireAt: "2026-10-18T11:00:00.000Z" });
const past = (id: string): ScheduledReminder => ({ id, message: `m-${id}`, fireAt: "2026-10-18T09:00:00.000Z" });

test("recorded reminders are listed back, shared by any caller of the same store", async () => {
  const store = fakeStore();
  await recordReminder(store, soon("a"));
  await recordReminder(store, soon("b"));
  assert.deepEqual(await listUpcomingReminders(store, now), { status: "ok", reminders: [soon("a"), soon("b")] });
});

test("concurrent records do not lose entries", async () => {
  const store = fakeStore();
  const ids = ["a", "b", "c", "d"];
  const results = await Promise.all(ids.map((id) => recordReminder(store, soon(id))));
  assert.deepEqual(results, [true, true, true, true]);
  assert.deepEqual(store.snapshot().map((r) => r.id).sort(), ids);
});

test("forgetting removes only that reminder, and an unknown id is harmless", async () => {
  const store = fakeStore();
  await recordReminder(store, soon("a"));
  await recordReminder(store, soon("b"));
  await forgetReminder(store, "a");
  await forgetReminder(store, "zzz");
  assert.deepEqual(store.snapshot().map((r) => r.id), ["b"]);
});

test("listing drops reminders that already fired and prunes them from the store", async () => {
  const store = fakeStore();
  await recordReminder(store, past("old"));
  await recordReminder(store, soon("new"));
  assert.deepEqual(await listUpcomingReminders(store, now), { status: "ok", reminders: [soon("new")] });
  assert.deepEqual(store.snapshot().map((r) => r.id), ["new"]);
});

test("a store that cannot be read makes listing unavailable, not empty", async () => {
  assert.deepEqual(await listUpcomingReminders(fakeStore({ failReads: true }), now), { status: "unavailable" });
});

test("a failing store never throws out of record or forget", async () => {
  const store = fakeStore({ failReads: true });
  assert.equal(await recordReminder(store, soon("a")), false);
  assert.equal(await forgetReminder(store, "a"), false);
});

test("an empty store lists no reminders", async () => {
  assert.deepEqual(await listUpcomingReminders(fakeStore(), now), { status: "ok", reminders: [] });
});

test("listing does not write when nothing is past", async () => {
  const store = fakeStore();
  await recordReminder(store, soon("a"));
  const before = store.writes;
  await listUpcomingReminders(store, now);
  await listUpcomingReminders(fakeStore(), now);
  assert.equal(store.writes, before);
});

test("a conflict that never clears gives up after bounded retries without throwing", async () => {
  let reads = 0;
  const store: ReminderListStore = {
    async read() {
      reads += 1;
      return { reminders: [], etag: "x" };
    },
    async write() {
      throw new ReminderListConflict("always stale");
    },
  };
  assert.equal(await recordReminder(store, soon("a")), false);
  assert.equal(reads, 6);
});

test("forgetting gives up on a hanging store within the deadline", async () => {
  const store: ReminderListStore = { read: () => new Promise(() => {}), write: async () => {} };
  const started = Date.now();
  assert.equal(await forgetReminderWithin(store, "a", 50), false);
  assert.ok(Date.now() - started < 1000);
});

test("a corrupt or schema-mismatched document parses as an empty list", () => {
  assert.deepEqual(parseReminderDocument("not json"), []);
  assert.deepEqual(parseReminderDocument(JSON.stringify({ reminders: [{ id: 1 }] })), []);
  assert.deepEqual(parseReminderDocument(JSON.stringify({ reminders: [soon("a")] })), [soon("a")]);
});

test("a repaired empty list with an etag accepts the next write", async () => {
  let written: ScheduledReminder[] | null = null;
  const store: ReminderListStore = {
    read: async () => ({ reminders: parseReminderDocument("garbage"), etag: "corrupt-etag" }),
    async write(next, expected) {
      assert.deepEqual(expected, { etag: "corrupt-etag" });
      written = next;
    },
  };
  assert.equal(await recordReminder(store, soon("a")), true);
  assert.deepEqual(written, [soon("a")]);
});
