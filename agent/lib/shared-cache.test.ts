import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryCache, sealedCache } from "#lib/shared-cache.js";

test("a sealed value round-trips, and the underlying cache sees neither the key nor the value", async () => {
  const raw = memoryCache();
  const seen: { key: string; value: unknown }[] = [];
  const spy = { ...raw, set: async (key: string, value: unknown, ttl: number) => {
    seen.push({ key, value });
    await raw.set(key, value, ttl);
  } };
  const cache = sealedCache(spy, "server-secret");
  await cache.set("google-token:scl_personal", "ya29.secret-token", 60);
  assert.equal(await cache.get("google-token:scl_personal"), "ya29.secret-token");
  const stored = JSON.stringify(seen);
  assert.doesNotMatch(stored, /scl_personal|ya29/u);
});

test("a different secret reads nothing", async () => {
  const raw = memoryCache();
  await sealedCache(raw, "old-secret").set("k", { a: 1 }, 60);
  assert.equal(await sealedCache(raw, "new-secret").get("k"), null);
});

test("a value moved to another key fails to open", async () => {
  const raw = memoryCache();
  const cache = sealedCache(raw, "s");
  await cache.set("a", "token-a", 60);
  await cache.set("b", "token-b", 60);
  const names: string[] = [];
  const recorder = sealedCache({ ...raw, get: async (key) => (names.push(key), raw.get(key)) }, "s");
  await recorder.get("a");
  await recorder.get("b");
  const [nameA, nameB] = names as [string, string];
  await raw.set(nameB, await raw.get(nameA), 60);
  assert.equal(await cache.get("b"), null);
});
