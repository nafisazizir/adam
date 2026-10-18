import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { afterCallAuth, liveCallAuth, notFromOwnerChat } from "#lib/calls.js";
import cancelReminder from "#tools/cancel_reminder.js";
import messageCodingSession from "#tools/message_coding_session.js";
import startCodingSession from "#tools/start_coding_session.js";
import stopCodingSession from "#tools/stop_coding_session.js";

const owner = { issuer: "photon-imessage", principalId: "+61412345678" };
const realFetch = globalThis.fetch;
let fetched: string[] = [];

beforeEach(() => {
  fetched = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    throw new Error("no network in tests");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

type Executable = { execute: (input: never, ctx: never) => Promise<unknown> };

function onCall(auth: ReturnType<typeof afterCallAuth>) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

const tools: [string, Executable, Record<string, unknown>][] = [
  ["start_coding_session", startCodingSession as unknown as Executable, { brief: "build it", title: "Build it" }],
  ["message_coding_session", messageCodingSession as unknown as Executable, { sessionId: "devin-1", message: "go" }],
  ["stop_coding_session", stopCodingSession as unknown as Executable, { sessionId: "devin-1" }],
  ["cancel_reminder", cancelReminder as unknown as Executable, { id: "msg_1" }],
];

for (const [name, tool, input] of tools) {
  test(`${name} refuses on a call turn without reaching its service`, async () => {
    const calls = [
      { conversationId: "conv_1", transport: "whatsapp" as const },
      { conversationId: "conv_2", transport: "phone" as const },
    ];
    const auths = calls.flatMap((call) => [liveCallAuth(owner, call, Date.now() + 60_000), afterCallAuth(owner, call)]);
    for (const auth of auths) {
      const result = (await tool.execute(input as never, onCall(auth))) as { reason?: string };
      assert.equal(result.reason, notFromOwnerChat);
    }
    assert.deepEqual(fetched, []);
  });
}
