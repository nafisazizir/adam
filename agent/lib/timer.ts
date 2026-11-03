import { createHash } from "node:crypto";

import { z } from "zod";

import { type DocumentStore, readDocument, updateDocument } from "#lib/json-document.js";

export interface TimerBackend {
  readonly maxDelaySeconds: number;
  publish(input: { url: string; body: unknown; delaySeconds: number; deduplicationId: string }): Promise<string>;
  cancel(messageId: string): Promise<"cancelled" | "gone">;
}

export interface TimerRequest {
  readonly url: string;
  readonly body: unknown;
  readonly fireAtMs: number;
  // Stable per logical timer, so a retried or replayed call does not set it twice.
  readonly key: string;
}

const longTimerSchema = z.object({ id: z.string(), fireAt: z.string(), messageId: z.string() });
export const longTimersSchema = z.object({ timers: z.array(longTimerSchema) });
export type LongTimers = z.infer<typeof longTimersSchema>;
type LongTimer = z.infer<typeof longTimerSchema>;
export const noLongTimers: LongTimers = { timers: [] };

export const hopSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  body: z.unknown(),
  fireAt: z.string().min(1),
  key: z.string().min(1),
});
export type Hop = z.infer<typeof hopSchema>;

const longTimerPrefix = "timer_";
const hourMs = 60 * 60 * 1000;
const keepFiredMs = 24 * hourMs;

export interface Timers {
  set(request: TimerRequest): Promise<string>;
  cancel(id: string): Promise<"cancelled" | "gone">;
  hop(hop: Hop, messageId: string | null): Promise<"forwarded" | "stale">;
}

type Leg = { readonly final: boolean; readonly delaySeconds: number; readonly atMs: number };

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function deduplicationId(key: string): string {
  return key.replace(/[^\w-]/gu, "_");
}

// One id per key: setting a key again replaces its timer, and only the newest chain stays live.
function timerId(key: string): string {
  return `${longTimerPrefix}${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function withoutFired(timers: LongTimer[], now: number): LongTimer[] {
  return timers.filter((timer) => Date.parse(timer.fireAt) > now - keepFiredMs);
}

// A timer beyond the backend's longest delay hops toward its instant: each hop lands with at most
// one horizon left, and the last leg goes straight to the destination.
export function createTimers(input: {
  backend: TimerBackend;
  store: DocumentStore<LongTimers>;
  hopUrl: string;
  now?: () => number;
}): Timers {
  const { backend, store, hopUrl } = input;
  const now = input.now ?? Date.now;
  const horizonMs = backend.maxDelaySeconds * 1000 - hourMs;

  function nextLeg(fireAtMs: number, at: number): Leg {
    const remaining = fireAtMs - at;
    if (remaining <= horizonMs) return { final: true, delaySeconds: seconds(remaining), atMs: fireAtMs };
    const hopMs = Math.min(horizonMs, remaining - horizonMs);
    return { final: false, delaySeconds: seconds(hopMs), atMs: at + hopMs };
  }

  // Counted back from the instant, so a replayed set lands on the same id as the first.
  function legsLeft(hop: Hop, leg: Leg): number {
    return Math.ceil((Date.parse(hop.fireAt) - leg.atMs) / horizonMs);
  }

  function publishLeg(leg: Leg, hop: Hop): Promise<string> {
    return leg.final
      ? backend.publish({
          url: hop.url,
          body: hop.body,
          delaySeconds: leg.delaySeconds,
          deduplicationId: deduplicationId(hop.key),
        })
      : backend.publish({
          url: hopUrl,
          body: hop,
          delaySeconds: leg.delaySeconds,
          deduplicationId: deduplicationId(`${hop.key}-hop-${legsLeft(hop, leg)}`),
        });
  }

  async function cancelQuietly(messageId: string): Promise<void> {
    try {
      await backend.cancel(messageId);
    } catch (error) {
      console.warn(`[timer] could not cancel ${messageId}`, error);
    }
  }

  return {
    async set(request) {
      const at = now();
      const leg = nextLeg(request.fireAtMs, at);
      const hop: Hop = {
        id: timerId(request.key),
        url: request.url,
        body: request.body,
        fireAt: new Date(request.fireAtMs).toISOString(),
        key: request.key,
      };
      if (leg.final) return publishLeg(leg, hop);

      // An unrecorded hop finds no record when it lands and stops, so a failed write needs no cleanup.
      const messageId = await publishLeg(leg, hop);
      await updateDocument(store, noLongTimers, (current) => ({
        next: {
          timers: [
            ...withoutFired(current.timers, at).filter((timer) => timer.id !== hop.id),
            { id: hop.id, fireAt: hop.fireAt, messageId },
          ],
        },
        result: undefined,
      }));
      return hop.id;
    },

    async cancel(id) {
      if (!id.startsWith(longTimerPrefix)) return backend.cancel(id);
      const at = now();
      const removed = await updateDocument(store, noLongTimers, (current) => {
        const timer = current.timers.find((entry) => entry.id === id);
        if (!timer) return { next: current, result: null };
        return { next: { timers: withoutFired(current.timers, at).filter((entry) => entry.id !== id) }, result: timer };
      });
      if (!removed || Date.parse(removed.fireAt) <= at) return "gone";
      await backend.cancel(removed.messageId);
      return "cancelled";
    },

    // The stored message id is the live leg; any other delivery is a duplicate or a cancelled timer.
    async hop(hop, messageId) {
      const live = (await readDocument(store, noLongTimers)).timers.find((entry) => entry.id === hop.id);
      if (!live || live.messageId !== messageId) return "stale";

      const at = now();
      const leg = nextLeg(Date.parse(hop.fireAt), at);
      const next = await publishLeg(leg, hop);
      const outcome = await updateDocument(store, noLongTimers, (current) => {
        const entry = current.timers.find((timer) => timer.id === hop.id);
        if (entry?.messageId !== messageId) return { next: current, result: { kept: false, live: entry?.messageId } };
        return {
          next: {
            timers: withoutFired(current.timers, at).map((timer) =>
              timer.id === hop.id ? { ...timer, messageId: next } : timer,
            ),
          },
          result: { kept: true, live: next },
        };
      });
      if (outcome.kept) return "forwarded";
      // A losing final leg would fire unchecked, unless QStash deduplicated it onto the live one.
      if (leg.final && next !== outcome.live) await cancelQuietly(next);
      return "stale";
    },
  };
}
