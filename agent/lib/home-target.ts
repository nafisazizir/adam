import { get } from "@vercel/blob";
import { z } from "zod";

import { BlobWriteConflict, putConditional } from "#lib/blob-conditional.js";
import { env } from "#lib/env.js";

const pathname = "home-target.json";
const PRESENCE_REFRESH_MS = 10 * 60 * 1000;

const homeOwnerSchema = z.object({
  issuer: z.string(),
  principalId: z.string(),
});

const channelPresenceSchema = z.object({
  target: z.record(z.string(), z.unknown()),
  lastInboundAt: z.iso.datetime().optional(),
});

// `channel`, `target` and `owner` keep their first meaning (the iMessage home thread and the
// owner), so a pointer written before `channels` existed still parses. A malformed `channels` is
// dropped rather than failing the schema, because an unusable pointer drops every message.
const homeTargetSchema = z.object({
  channel: z.string(),
  target: z.record(z.string(), z.unknown()),
  owner: homeOwnerSchema,
  channels: z.record(z.string(), channelPresenceSchema).optional().catch(undefined),
});

export type HomeOwner = z.infer<typeof homeOwnerSchema>;

export type ChannelPresence = z.infer<typeof channelPresenceSchema>;

export type HomeTarget = z.infer<typeof homeTargetSchema>;

export function parseHomeTarget(payload: unknown): HomeTarget | null {
  const parsed = homeTargetSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

// Every channel the owner has written from. The primary's target is always the top-level one,
// which its own channel keeps current.
export function homeChannels(home: HomeTarget): Record<string, ChannelPresence> {
  return { ...home.channels, [home.channel]: { ...home.channels?.[home.channel], target: home.target } };
}

const primaryOf = ({ channel, target, owner }: HomeTarget) => JSON.stringify({ channel, target, owner });

export function withPrimary(current: HomeTarget | null, primary: HomeTarget): HomeTarget | null {
  if (current && primaryOf(current) === primaryOf(primary)) return null;
  const { channel, target, owner } = primary;
  return current?.channels ? { channel, target, owner, channels: current.channels } : { channel, target, owner };
}

// Reachability only needs the last inbound to within the delivery margin, so a write per message
// would just spend Blob operations; a time never moves backwards.
function refreshes(stored: string | undefined, next: string): boolean {
  if (stored === undefined) return true;
  return !(Date.parse(next) - Date.parse(stored) < PRESENCE_REFRESH_MS);
}

// Only an existing pointer gains a channel: who the owner is gets decided elsewhere, never here.
export function withPresence(
  current: HomeTarget | null,
  name: string,
  presence: Required<ChannelPresence>,
): HomeTarget | null {
  if (!current) return null;
  const stored = current.channels?.[name];
  const sameTarget = stored !== undefined && JSON.stringify(stored.target) === JSON.stringify(presence.target);
  if (sameTarget && !refreshes(stored.lastInboundAt, presence.lastInboundAt)) return null;
  return { ...current, channels: { ...current.channels, [name]: presence } };
}

let lastKnown: HomeTarget | undefined;
let warnedMissingToken = false;

function token(): string | null {
  if (env.BLOB_READ_WRITE_TOKEN) return env.BLOB_READ_WRITE_TOKEN;

  if (!warnedMissingToken) {
    console.warn("[home-target] Vercel Blob is not configured; home target is unavailable");
    warnedMissingToken = true;
  }

  return null;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readStored(blobToken: string): Promise<{ home: HomeTarget | null; etag: string } | null> {
  const result = await get(pathname, { access: "private", token: blobToken, useCache: false });
  if (result === null) return null;
  if (result.statusCode !== 200) throw new Error(`reading the home target returned status ${result.statusCode}`);
  const text = await new Response(result.stream).text();
  return { home: parseHomeTarget(parseJsonText(text)), etag: result.blob.etag };
}

// Two channels write the pointer, so each write starts from a fresh read and lands only if nothing
// changed since; losing that race retries once against the newer copy.
async function updateHomeTarget(change: (current: HomeTarget | null) => HomeTarget | null): Promise<void> {
  if (lastKnown && change(lastKnown) === null) return;
  const blobToken = token();
  if (!blobToken) return;

  for (let attempt = 1; ; attempt += 1) {
    const stored = await readStored(blobToken);
    const next = change(stored?.home ?? null);
    if (next === null) {
      lastKnown = stored?.home ?? undefined;
      return;
    }

    try {
      await putConditional(pathname, JSON.stringify(next), stored ? { etag: stored.etag } : "absent", blobToken);
      lastKnown = next;
      return;
    } catch (error) {
      if (!(error instanceof BlobWriteConflict) || attempt >= 2) throw error;
    }
  }
}

export function rememberHomeTarget(home: HomeTarget): Promise<void> {
  return updateHomeTarget((current) => withPrimary(current, home));
}

export function rememberChannelPresence(name: string, presence: Required<ChannelPresence>): Promise<void> {
  return updateHomeTarget((current) => withPresence(current, name, presence));
}

const POINTER_WRITE_BUDGET_MS = 1500;

// A chat channel writes the pointer before its turn starts, so a slow Blob must not hold up the
// reply: past the budget the write carries on unawaited and the turn goes ahead.
export async function rememberWithinBudget(label: string, write: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[${label}] gave up waiting on the home pointer after ${POINTER_WRITE_BUDGET_MS}ms`);
      resolve();
    }, POINTER_WRITE_BUDGET_MS);
  });
  const written = write().catch((error: unknown) => {
    console.warn(`[${label}] failed to remember the home target`, error);
  });
  try {
    await Promise.race([written, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// The first owner is claimed with `allowOverwrite: false`, so when two people text a fresh install
// at once only one write lands and the other claim fails.
export async function claimHomeTarget(home: HomeTarget): Promise<void> {
  const blobToken = token();
  if (!blobToken) throw new Error("Vercel Blob is not configured");

  await putConditional(pathname, JSON.stringify(home), "absent", blobToken);
  lastKnown = home;
}

export type HomeTargetRead =
  | { readonly status: "found"; readonly home: HomeTarget }
  | { readonly status: "absent" }
  | { readonly status: "unconfigured" }
  | { readonly status: "invalid"; readonly reason: string };

// Only a 404 is "absent": callers deciding who the owner is must not mistake a broken pointer for
// a fresh install.
export async function readHomeTargetState(): Promise<HomeTargetRead> {
  const blobToken = token();
  if (!blobToken) return { status: "unconfigured" };

  const result = await get(pathname, { access: "private", token: blobToken });
  if (result === null) return { status: "absent" };
  if (result.statusCode !== 200) return { status: "invalid", reason: `status ${result.statusCode}` };

  const payload = parseJsonText(await new Response(result.stream).text());
  if (payload === undefined) return { status: "invalid", reason: "not JSON" };

  const home = parseHomeTarget(payload);
  return home ? { status: "found", home } : { status: "invalid", reason: "does not match the home target schema" };
}

export async function readHomeTarget(): Promise<HomeTarget | null> {
  const read = await readHomeTargetState();
  return read.status === "found" ? read.home : null;
}
