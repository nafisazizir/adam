import assert from "node:assert/strict";
import { test } from "node:test";

import { outboundCallBriefing } from "#lib/calls.js";
import { parseVapiEvent, parseVapiToolCalls, placeVapiCall, vapiAssistant, vapiLine } from "#lib/vapi.js";
import { CallNotPlaced } from "#lib/voice.js";

const line = vapiLine({
  apiKey: "vapi-key",
  phoneNumberId: "pn_1",
  toolSecret: "s3cret",
  toolsUrl: "https://adam.test/eve/v1/vapi/tools",
  eventsUrl: "https://adam.test/eve/v1/vapi/events",
})!;
const briefing = outboundCallBriefing("Mon 9 Nov, 6:30 pm", "Your flight is delayed.");
const outboundCall = { id: "call_1", type: "outboundPhoneCall", customer: { number: "+61412345678" } };

test("a Vapi line needs its key, its number and the tool secret", () => {
  const urls = { toolsUrl: "t", eventsUrl: "e" };
  assert.ok(line);
  assert.equal(vapiLine({ ...urls, apiKey: "k", phoneNumberId: "pn" }), null);
  assert.equal(vapiLine({ ...urls, apiKey: "k", toolSecret: "s" }), null);
  assert.equal(vapiLine({ ...urls, phoneNumberId: "pn", toolSecret: "s" }), null);
});

test("the assistant speaks the briefing with Deepgram's ears and no office noise, and asks Adam over the secret header", () => {
  const assistant = vapiAssistant(briefing, line);
  assert.equal(assistant.firstMessage, briefing.greeting);
  assert.equal(assistant.model.messages[0]?.content, briefing.briefing);
  assert.deepEqual(assistant.transcriber, { provider: "deepgram", model: "flux-general-en" });
  assert.equal(assistant.backgroundSound, "off");
  assert.equal(assistant.voice.provider, "deepgram");
  const ask = assistant.model.tools[0] as { function: { name: string }; server: { url: string; headers: Record<string, string> } };
  assert.equal(ask.function.name, "ask_adam");
  assert.equal(ask.server.url, line.toolsUrl);
  assert.equal(ask.server.headers["x-calls-secret"], "s3cret");
  assert.equal(assistant.server.headers["x-calls-secret"], "s3cret");
});

test("Adam's ElevenLabs voice speaks when there is one", () => {
  const voice = vapiAssistant(briefing, { ...line, elevenLabsVoiceId: "voice_1" }).voice;
  assert.deepEqual(voice, { provider: "11labs", model: "eleven_v4_turbo", voiceId: "voice_1" });
});

test("placing a call returns Vapi's call id", async () => {
  let sent: { url: string; body: { phoneNumberId: string; customer: { number: string } } } | null = null;
  const placed = await placeVapiCall(line, { toNumber: "+61412345678", briefing }, async (url, init) => {
    sent = { url: String(url), body: JSON.parse(String(init?.body)) };
    return Response.json({ id: "call_1" }, { status: 201 });
  });
  assert.deepEqual(placed, { conversationId: "call_1" });
  assert.equal(sent!.url, "https://api.vapi.ai/call");
  assert.equal(sent!.body.phoneNumberId, "pn_1");
  assert.equal(sent!.body.customer.number, "+61412345678");
});

test("a refused call certainly did not ring, but a 5xx might have", async () => {
  const refuse = async () => new Response("bad voice", { status: 400 });
  await assert.rejects(placeVapiCall(line, { toNumber: "+61412345678", briefing }, refuse), CallNotPlaced);
  const fail = async () => new Response("oops", { status: 502 });
  await assert.rejects(placeVapiCall(line, { toNumber: "+61412345678", briefing }, fail), (error) => !(error instanceof CallNotPlaced));
});

test("ask_adam on an outbound call relays the request with the dialled number as the other party", () => {
  const calls = parseVapiToolCalls({
    message: {
      type: "tool-calls",
      call: outboundCall,
      toolCallList: [
        { id: "tc_1", function: { name: "ask_adam", arguments: { request: "find dinner near Vapi HQ" } } },
        { id: "tc_2", function: { name: "ask_adam", arguments: JSON.stringify({ request: "and text me the link" }) } },
        { id: "tc_3", function: { name: "something_else", arguments: { request: "x" } } },
      ],
    },
  });
  assert.deepEqual(calls, [
    {
      toolCallId: "tc_1",
      ask: {
        direction: "outbound",
        callerNumber: null,
        calledNumber: "+61412345678",
        conversationId: "call_1",
        request: "find dinner near Vapi HQ",
      },
    },
    {
      toolCallId: "tc_2",
      ask: {
        direction: "outbound",
        callerNumber: null,
        calledNumber: "+61412345678",
        conversationId: "call_1",
        request: "and text me the link",
      },
    },
    { toolCallId: "tc_3", ask: null },
  ]);
  assert.equal(parseVapiToolCalls({ message: { type: "status-update" } }), null);
});

test("an inbound call's customer is the caller", () => {
  const calls = parseVapiToolCalls({
    message: {
      type: "tool-calls",
      call: { ...outboundCall, type: "inboundPhoneCall" },
      toolCallList: [{ id: "tc_1", function: { name: "ask_adam", arguments: { request: "hi" } } }],
    },
  });
  assert.equal(calls?.[0]?.ask?.direction, "inbound");
  assert.equal(calls?.[0]?.ask?.callerNumber, "+61412345678");
});

test("the end-of-call report becomes the same call summary ElevenLabs sends", () => {
  const event = parseVapiEvent({
    message: {
      type: "end-of-call-report",
      call: outboundCall,
      startedAt: "2026-11-10T02:30:00.000Z",
      durationSeconds: 42.5,
      analysis: { summary: "Found dinner options." },
      artifact: {
        messages: [
          { role: "system", message: "prompt" },
          { role: "bot", message: "Hey, it's Adam." },
          { role: "user", message: "Find me dinner." },
          { role: "tool_calls", message: "" },
        ],
      },
    },
  });
  assert.deepEqual(event, {
    kind: "ended",
    ended: {
      direction: "outbound",
      callerNumber: null,
      calledNumber: "+61412345678",
      conversationId: "call_1",
      summary: "Found dinner options.",
      transcript: [
        { speaker: "adam", text: "Hey, it's Adam." },
        { speaker: "caller", text: "Find me dinner." },
      ],
      startedAt: "2026-11-10T02:30:00.000Z",
      durationSecs: 42.5,
    },
  });
  assert.deepEqual(parseVapiEvent({ message: { type: "status-update" } }), { kind: "ignored" });
  assert.deepEqual(parseVapiEvent({ message: { type: "end-of-call-report" } }), { kind: "invalid" });
});
