import type { SessionAuthContext } from "eve/context";
import {
  defineMemoryProvider,
  type MemoryOperationContext,
  type MemoryProvider,
  type MemoryRecallHandler,
} from "eve/memory";

// Eve fails the turn when recall throws. These memories are advisory facts, so a Blob outage or a
// corrupt document costs one turn's recall instead of every reply; an abort is still cancellation.
function bestEffort<T extends MemoryOperationContext>(
  label: string,
  recall: MemoryRecallHandler<T>,
): MemoryRecallHandler<T> {
  return async (ctx) => {
    try {
      return await recall(ctx);
    } catch (error) {
      if (ctx.abortSignal.aborted) throw error;
      console.error(`[${label}] recall failed`, error);
      return null;
    }
  };
}

export function guardedMemory(
  inner: MemoryProvider,
  options: { label: string; canWrite(auth: SessionAuthContext | null): boolean },
): MemoryProvider {
  const compaction = inner.recall["compaction.completed"];
  return defineMemoryProvider({
    recall: {
      "turn.started": bestEffort(options.label, inner.recall["turn.started"]),
      ...(compaction && { "compaction.completed": bestEffort(options.label, compaction) }),
    },
    ...(inner.capture && { capture: inner.capture }),
    async tools(ctx) {
      if (!inner.tools || !options.canWrite(ctx.session.auth.current)) return null;
      return inner.tools(ctx);
    },
  });
}
