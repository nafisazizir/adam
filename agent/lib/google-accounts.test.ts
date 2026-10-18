import assert from "node:assert/strict";
import { test } from "node:test";

import {
  googleAccountRegistry,
  GoogleAccountsConflict,
  type GoogleAccountRecord,
  type GoogleAccountStore,
  InvalidAccountLabelError,
  normalizeAccountLabel,
  parseGoogleAccountsDocument,
} from "#lib/google-accounts.js";
import { memoryCache } from "#lib/shared-cache.js";

function fakeStore(options: { conflicts?: number } = {}) {
  let version = 0;
  let accounts: GoogleAccountRecord[] | null = null;
  let conflicts = options.conflicts ?? 0;
  const store: GoogleAccountStore & { reads: number; writes: number; labels(): string[] } = {
    reads: 0,
    writes: 0,
    labels: () => (accounts ?? []).map((account) => account.label),
    async read() {
      store.reads += 1;
      await Promise.resolve();
      return accounts ? { accounts: [...accounts], etag: String(version) } : null;
    },
    async write(next, expected) {
      await Promise.resolve();
      if (conflicts > 0) {
        conflicts -= 1;
        throw new GoogleAccountsConflict("someone else wrote first");
      }
      const current = accounts ? String(version) : "absent";
      if (current !== (expected === "absent" ? "absent" : expected.etag)) throw new GoogleAccountsConflict("stale");
      accounts = next;
      version += 1;
      store.writes += 1;
    },
  };
  return store;
}

const fixedNow = () => new Date("2026-10-18T00:00:00Z");

function registry(store: GoogleAccountStore, cache = memoryCache()) {
  return googleAccountRegistry({ store, cache, cacheTtlSeconds: 300, now: fixedNow });
}

test("labels are lowercased and slugged from the owner's words", () => {
  assert.equal(normalizeAccountLabel("Work"), "work");
  assert.equal(normalizeAccountLabel("  Side Hustle "), "side-hustle");
  assert.equal(normalizeAccountLabel("uni_2026"), "uni-2026");
  assert.equal(normalizeAccountLabel("Mum's--account!"), "mums-account");
});

test("an address, an empty name or an overlong one is not a label", () => {
  for (const raw of ["me@work.example", "", "   ", "!!!", "工作", "x".repeat(33)]) {
    assert.throws(() => normalizeAccountLabel(raw), InvalidAccountLabelError);
  }
});

test("an added account is listed back, and adding it again writes nothing", async () => {
  const store = fakeStore();
  const accounts = registry(store);
  assert.deepEqual(await accounts.add("Work"), {
    account: { label: "work", addedAt: "2026-10-18T00:00:00.000Z" },
    added: true,
  });
  assert.equal((await accounts.add("work")).added, false);
  assert.equal(store.writes, 1);
  assert.deepEqual(await accounts.list(), [{ label: "work", addedAt: "2026-10-18T00:00:00.000Z" }]);
});

test("concurrent adds keep every account", async () => {
  const store = fakeStore();
  const accounts = registry(store);
  await Promise.all(["personal", "work", "uni", "side"].map((label) => accounts.add(label)));
  assert.deepEqual(store.labels().sort(), ["personal", "side", "uni", "work"]);
});

test("a write that loses the race is retried on the newer list", async () => {
  const store = fakeStore({ conflicts: 2 });
  await registry(store).add("work");
  assert.deepEqual(store.labels(), ["work"]);
});

test("a list that keeps changing underneath gives up with the conflict", async () => {
  const store = fakeStore({ conflicts: 100 });
  await assert.rejects(registry(store).add("work"), GoogleAccountsConflict);
});

test("removing drops only that account and says whether it was there", async () => {
  const store = fakeStore();
  const accounts = registry(store);
  await accounts.add("personal");
  await accounts.add("work");
  assert.equal(await accounts.remove("work"), true);
  assert.equal(await accounts.remove("work"), false);
  assert.deepEqual(store.labels(), ["personal"]);
  assert.deepEqual(
    (await accounts.list()).map((account) => account.label),
    ["personal"],
  );
});

test("reads come from the cache, and fresh goes back to the store", async () => {
  const store = fakeStore();
  const cache = memoryCache();
  await registry(store, cache).add("personal");
  const reads = store.reads;

  const other = registry(store, cache);
  await other.list();
  await other.list();
  assert.equal(store.reads, reads);

  await registry(store).add("work");
  assert.deepEqual(
    (await other.list()).map((account) => account.label),
    ["personal"],
  );
  assert.deepEqual(
    (await other.list({ fresh: true })).map((account) => account.label),
    ["personal", "work"],
  );
  assert.deepEqual(
    (await other.list()).map((account) => account.label),
    ["personal", "work"],
  );
});

test("a cache entry expires, so a change elsewhere shows up within its lifetime", async () => {
  let now = 0;
  const store = fakeStore();
  const cache = memoryCache(() => now);
  const accounts = registry(store, cache);
  assert.deepEqual(await accounts.list(), []);
  await registry(store).add("work");
  assert.deepEqual(await accounts.list(), []);
  now += 301_000;
  assert.deepEqual(
    (await accounts.list()).map((account) => account.label),
    ["work"],
  );
});

test("an absent document is an empty list", async () => {
  assert.deepEqual(await registry(fakeStore()).list(), []);
});

test("a corrupt document fails loudly rather than reading as empty", () => {
  assert.deepEqual(parseGoogleAccountsDocument('{"accounts":[{"label":"work","addedAt":"x"}]}'), [
    { label: "work", addedAt: "x" },
  ]);
  for (const text of ["not json", '{"accounts":"work"}', "{}"]) {
    assert.throws(() => parseGoogleAccountsDocument(text), /unreadable/u);
  }
});

test("a read that overlaps a write does not put the older list back in the cache", async () => {
  const store = fakeStore();
  const cache = memoryCache();
  await registry(store, cache).add("work");
  await cache.delete("google-accounts");

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let readDone: () => void = () => {};
  const readStarted = new Promise<void>((resolve) => {
    readDone = resolve;
  });
  const slow: GoogleAccountStore = {
    read: async () => {
      const before = await store.read();
      readDone();
      await gate;
      return before;
    },
    write: (accounts, expected) => store.write(accounts, expected),
  };
  const reading = registry(slow, cache).list();
  await readStarted;
  await registry(store, cache).remove("work");
  release();
  assert.deepEqual(await reading, []);
  assert.deepEqual(await registry(store, cache).list(), []);
});
