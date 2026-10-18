import { createHash } from "node:crypto";

interface ReplayContext {
  readonly session: { readonly id: string; readonly turn: { readonly id: string } };
}

// callId is minted by the model call, so a step that re-runs after an interruption gets new ones;
// the session and turn exist before the step, and the hash keeps distinct calls in a turn apart.
export function replayStableKey(ctx: ReplayContext, ...inputs: readonly (string | number)[]): string {
  const digest = createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
  return `${ctx.session.id}-${ctx.session.turn.id}-${digest}`;
}
