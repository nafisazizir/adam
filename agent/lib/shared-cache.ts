import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { getCache } from "@vercel/functions";

import { env } from "#lib/env.js";

export interface SharedCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// getCache's default key hash is 32 bits, so two keys could share an entry.
function runtimeCache() {
  return getCache({
    namespace: "adam",
    keyHashFunction: (key) => createHash("sha256").update(key).digest("hex"),
  });
}

// Vercel Runtime Cache is shared by every instance in a region, and on Hobby by every project in the
// team; off Vercel, getCache falls back to one in-memory cache per process. It is a cache, not a
// store: a failure reads as a miss and a write that fails is dropped.
export const sharedCache: SharedCache = {
  async get(key) {
    try {
      return (await runtimeCache().get(key)) ?? null;
    } catch (error) {
      console.warn("[shared-cache] a read failed; treating it as a miss", error);
      return null;
    }
  },
  async set(key, value, ttlSeconds) {
    try {
      // An empty name keeps the key out of Vercel's dashboards.
      await runtimeCache().set(key, value, { ttl: Math.max(1, Math.floor(ttlSeconds)), name: "" });
    } catch (error) {
      console.warn("[shared-cache] a write failed", error);
    }
  },
  async delete(key) {
    try {
      await runtimeCache().delete(key);
    } catch (error) {
      console.warn("[shared-cache] a delete failed", error);
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

interface Sealed {
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

function isSealed(value: unknown): value is Sealed {
  const sealed = value as Partial<Sealed> | null;
  return typeof sealed?.iv === "string" && typeof sealed.ct === "string" && typeof sealed.tag === "string";
}

// Other projects can share the cache, so values are AES-256-GCM sealed (bound to their key) and
// key names are HMACs, both under keys derived from a server secret. A new secret only turns old
// entries into misses.
export function sealedCache(cache: SharedCache, secret: string): SharedCache {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", secret, "adam-shared-cache", info, 32));
  const encryptionKey = derive("encryption");
  const namingKey = derive("naming");
  const name = (key: string) => `sealed:${createHmac("sha256", namingKey).update(key).digest("hex")}`;

  return {
    async get(key) {
      const sealed = await cache.get(name(key));
      if (!isSealed(sealed)) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(sealed.iv, "base64"));
        decipher.setAAD(Buffer.from(key));
        decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
        const plain = Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
        return JSON.parse(plain.toString("utf8"));
      } catch {
        return null;
      }
    },
    async set(key, value, ttlSeconds) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(Buffer.from(key));
      const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      const sealed: Sealed = {
        iv: iv.toString("base64"),
        ct: ct.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
      await cache.set(name(key), sealed, ttlSeconds);
    },
    async delete(key) {
      await cache.delete(name(key));
    },
  };
}

export const secretCache = sealedCache(sharedCache, env.QSTASH_CURRENT_SIGNING_KEY);
