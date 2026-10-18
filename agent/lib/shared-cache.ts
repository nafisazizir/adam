import { getCache } from "@vercel/functions";

export interface SharedCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// Vercel Runtime Cache is shared by every instance in a region; off Vercel, getCache falls back to
// one in-memory cache per process. It is a cache, not a store: a failure reads as a miss and a
// write that fails is dropped.
export const sharedCache: SharedCache = {
  async get(key) {
    try {
      return (await getCache({ namespace: "adam" }).get(key)) ?? null;
    } catch (error) {
      console.warn(`[shared-cache] read of ${key} failed; treating it as a miss`, error);
      return null;
    }
  },
  async set(key, value, ttlSeconds) {
    try {
      // An empty name keeps the raw key, which can carry a principal id, out of Vercel's dashboards.
      await getCache({ namespace: "adam" }).set(key, value, { ttl: Math.floor(ttlSeconds), name: "" });
    } catch (error) {
      console.warn(`[shared-cache] write of ${key} failed`, error);
    }
  },
  async delete(key) {
    try {
      await getCache({ namespace: "adam" }).delete(key);
    } catch (error) {
      console.warn(`[shared-cache] delete of ${key} failed`, error);
    }
  },
};

export function memoryCache(now: () => number = Date.now): SharedCache {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now()) return null;
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}
