import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { afterCallAuth } from "#lib/calls.js";
import { routineAuth } from "#lib/routines.js";
import createRoutine from "#tools/create_routine.js";
import deleteRoutine from "#tools/delete_routine.js";
import updateRoutine from "#tools/update_routine.js";

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

function turn(auth: ReturnType<typeof routineAuth>) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

const tools: [string, Executable, Record<string, unknown>][] = [
  [
    "create_routine",
    createRoutine as unknown as Executable,
    { name: "x", instruction: "y", schedule: { every: "days", interval: 1, time: "08:00" } },
  ],
  ["update_routine", updateRoutine as unknown as Executable, { id: "routine_1", paused: true }],
  ["delete_routine", deleteRoutine as unknown as Executable, { id: "routine_1" }],
];

for (const [name, tool, input] of tools) {
  test(`${name} refuses a routine turn and a call without touching the store`, async () => {
    for (const auth of [routineAuth(owner, "2026-11-01T08:00:00.000Z"), afterCallAuth(owner, { conversationId: "c" })]) {
      await assert.rejects(tool.execute(input as never, turn(auth)), /needs the user's go-ahead in chat/u);
    }
    assert.deepEqual(fetched, []);
  });
}
