import { z } from "zod";

import type { SharedCache } from "#lib/shared-cache.js";

export interface GoogleAccountRecord {
  readonly label: string;
  readonly addedAt: string;
}

export interface StoredGoogleAccounts {
  readonly accounts: GoogleAccountRecord[];
  readonly etag: string;
}

export class GoogleAccountsConflict extends Error {}

export interface GoogleAccountStore {
  read(): Promise<StoredGoogleAccounts | null>;
  // Throws GoogleAccountsConflict when the document changed since `expected`.
  write(accounts: GoogleAccountRecord[], expected: { etag: string } | "absent"): Promise<void>;
}

export interface GoogleAccountRegistry {
  // `fresh` skips the cache, for a name the cached list may not have caught up with yet.
  list(options?: { fresh?: boolean }): Promise<GoogleAccountRecord[]>;
  add(label: string): Promise<{ account: GoogleAccountRecord; added: boolean }>;
  remove(label: string): Promise<boolean>;
}

const accountsSchema = z.array(z.object({ label: z.string().min(1), addedAt: z.string() }));
const documentSchema = z.object({ accounts: accountsSchema });

// A corrupt list fails loudly: reading it as empty would hide every account until the next connect
// overwrote it.
export function parseGoogleAccountsDocument(text: string): GoogleAccountRecord[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = documentSchema.safeParse(json);
  if (!parsed.success) throw new Error("the stored Google account list is unreadable; fix or delete it");
  return parsed.data.accounts;
}

export class InvalidAccountLabelError extends Error {}

const maxLabelLength = 32;

// A label is how the owner names an account in chat, so it is kept readable: "Work Gmail" → work-gmail.
export function normalizeAccountLabel(raw: string): string {
  if (raw.includes("@")) {
    throw new InvalidAccountLabelError(`"${raw}" is an address; name the account with a short word like work or personal.`);
  }
  const label = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (!label || label.length > maxLabelLength) {
    throw new InvalidAccountLabelError(
      `"${raw}" can't name an account: use 1 to ${maxLabelLength} letters, digits or dashes, like work or personal.`,
    );
  }
  return label;
}

const cacheKey = "google-accounts";
const maxAttempts = 6;

export interface GoogleAccountRegistryDeps {
  readonly store: GoogleAccountStore;
  readonly cache: SharedCache;
  readonly cacheTtlSeconds: number;
  readonly now?: () => Date;
}

// Reads come from the cache and fall back to the store; writes go to the store under its etag and
// then refresh the cache, so the store is read about once per cache lifetime.
export function googleAccountRegistry(deps: GoogleAccountRegistryDeps): GoogleAccountRegistry {
  const { store, cache, cacheTtlSeconds } = deps;
  const now = deps.now ?? (() => new Date());

  async function remember(accounts: GoogleAccountRecord[]): Promise<GoogleAccountRecord[]> {
    await cache.set(cacheKey, accounts, cacheTtlSeconds);
    return accounts;
  }

  async function update<T>(
    change: (accounts: GoogleAccountRecord[]) => { next: GoogleAccountRecord[] | null; result: T },
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const current = await store.read();
      const accounts = current?.accounts ?? [];
      const { next, result } = change(accounts);
      if (next === null) {
        await remember(accounts);
        return result;
      }
      try {
        await store.write(next, current ? { etag: current.etag } : "absent");
      } catch (error) {
        if (!(error instanceof GoogleAccountsConflict) || attempt === maxAttempts) throw error;
        continue;
      }
      await remember(next);
      return result;
    }
  }

  return {
    async list(options) {
      if (!options?.fresh) {
        const cached = accountsSchema.safeParse(await cache.get(cacheKey));
        if (cached.success) return cached.data;
      }
      const read = (await store.read())?.accounts ?? [];
      // A connect or disconnect that landed while this read was in flight has cached a newer list;
      // backfilling over it would bring back the old one for the cache's lifetime.
      if (!options?.fresh) {
        const landed = accountsSchema.safeParse(await cache.get(cacheKey));
        if (landed.success) return landed.data;
      }
      return remember(read);
    },

    add(raw) {
      const label = normalizeAccountLabel(raw);
      return update<{ account: GoogleAccountRecord; added: boolean }>((accounts) => {
        const existing = accounts.find((account) => account.label === label);
        if (existing) return { next: null, result: { account: existing, added: false } };
        const account = { label, addedAt: now().toISOString() };
        return { next: [...accounts, account], result: { account, added: true } };
      });
    },

    remove(label) {
      return update((accounts) => {
        const kept = accounts.filter((account) => account.label !== label);
        return kept.length === accounts.length ? { next: null, result: false } : { next: kept, result: true };
      });
    },
  };
}
