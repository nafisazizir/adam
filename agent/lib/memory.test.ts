import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { MemoryProvider } from "eve/memory";

import { guardedMemory } from "#lib/memory.js";

type RecallContext = Parameters<MemoryProvider["recall"]["turn.started"]>[0];
type ToolsContext = Parameters<NonNullable<MemoryProvider["tools"]>>[0];

const chat: SessionAuthContext = { attributes: {}, authenticator: "chat", principalId: "u", principalType: "user" };
const background: SessionAuthContext = { ...chat, authenticator: "background" };

function recallContext(signal = new AbortController().signal) {
  return { abortSignal: signal } as RecallContext;
}

function toolsContext(current: SessionAuthContext | null) {
  return { session: { id: "s", auth: { current, initiator: current } } } as ToolsContext;
}

function provider(recall: () => Promise<never> | { messages: { content: string }[] }): MemoryProvider {
  return {
    recall: { "turn.started": async () => recall(), "compaction.completed": async () => recall() },
    tools: async () => ({}),
  };
}

const canWrite = (auth: SessionAuthContext | null) => auth?.authenticator === "chat";

test("a failing recall yields no memory instead of failing the turn", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const guarded = guardedMemory(provider(() => Promise.reject(new Error("blob down"))), { label: "m", canWrite });
  assert.equal(await guarded.recall["turn.started"](recallContext()), null);
  assert.equal(await guarded.recall["compaction.completed"]?.(recallContext() as never), null);
  assert.equal(logged.mock.callCount(), 2);
});

test("a cancelled turn's recall error still propagates", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const guarded = guardedMemory(provider(() => Promise.reject(new Error("aborted"))), { label: "m", canWrite });
  await assert.rejects(async () => guarded.recall["turn.started"](recallContext(aborted.signal)), /aborted/);
});

test("a successful recall passes through", async () => {
  const messages = [{ content: "fact" }];
  const guarded = guardedMemory(provider(() => ({ messages })), { label: "m", canWrite });
  assert.deepEqual(await guarded.recall["turn.started"](recallContext()), { messages });
});

test("write tools are offered only when the caller may write", async () => {
  const guarded = guardedMemory(provider(() => ({ messages: [] })), { label: "m", canWrite });
  assert.deepEqual(await guarded.tools?.(toolsContext(chat)), {});
  assert.equal(await guarded.tools?.(toolsContext(background)), null);
  assert.equal(await guarded.tools?.(toolsContext(null)), null);
});
