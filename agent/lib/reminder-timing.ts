const minimumLeadMs = 5 * 60_000;

export type ReminderTiming =
  | { readonly kind: "schedule"; readonly delaySeconds: number; readonly fireAtMs: number }
  | { readonly kind: "skipped" }
  | { readonly kind: "past" };

export function reminderTiming(
  input: { readonly delaySeconds: number } | { readonly targetMs: number; readonly leadMinutes: number },
  nowMs: number,
): ReminderTiming {
  if ("delaySeconds" in input) {
    return schedule(nowMs + input.delaySeconds * 1000, nowMs);
  }
  const fireAtMs = input.targetMs - input.leadMinutes * 60_000;
  if (input.leadMinutes > 0) {
    return fireAtMs - nowMs < minimumLeadMs ? { kind: "skipped" } : schedule(fireAtMs, nowMs);
  }
  return fireAtMs <= nowMs ? { kind: "past" } : schedule(fireAtMs, nowMs);
}

function schedule(fireAtMs: number, nowMs: number): ReminderTiming {
  return { kind: "schedule", fireAtMs, delaySeconds: Math.max(1, Math.ceil((fireAtMs - nowMs) / 1000)) };
}
