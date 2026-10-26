import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  callEndedSignatureValid,
  hasCallsSecret,
  parseCallEnded,
  parseCallRequest,
  CallNotPlaced,
  callerNumberOf,
  callStartResponse,
  parseCallStart,
  placeOutboundCall,
  sameSecret,
} from "#lib/voice.js";

const secret = "wsec_test_secret";
const now = Date.UTC(2026, 9, 18, 9, 0, 0);
const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_1" } });

function sign(rawBody: string, at: number, key = secret): string {
  const timestamp = Math.floor(at / 1000);
  const hmac = createHmac("sha256", key).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v0=${hmac}`;
}

test("accepts a fresh signature over the exact body", () => {
  assert.ok(callEndedSignatureValid(sign(body, now), body, secret, now));
  assert.ok(callEndedSignatureValid(sign(body, now - 10 * 60 * 1000), body, secret, now));
});

test("rejects a tampered body, a wrong secret or a forged digest", () => {
  assert.ok(!callEndedSignatureValid(sign(body, now), body.replace("conv_1", "conv_2"), secret, now));
  assert.ok(!callEndedSignatureValid(sign(body, now, "another"), body, secret, now));
  assert.ok(!callEndedSignatureValid(`t=${Math.floor(now / 1000)},v0=deadbeef`, body, secret, now));
});

test("rejects a stale or far-future timestamp", () => {
  assert.ok(!callEndedSignatureValid(sign(body, now - 31 * 60 * 1000), body, secret, now));
  assert.ok(!callEndedSignatureValid(sign(body, now + 31 * 60 * 1000), body, secret, now));
});

test("rejects a missing or malformed header", () => {
  assert.ok(!callEndedSignatureValid(null, body, secret, now));
  assert.ok(!callEndedSignatureValid("v0=abc", body, secret, now));
  assert.ok(!callEndedSignatureValid("t=soon,v0=abc", body, secret, now));
});

test("compares the shared secret header exactly", () => {
  assert.ok(sameSecret("abc", "abc"));
  assert.ok(!sameSecret("abc", "abcd"));
  const request = (value?: string) =>
    new Request("https://adam.test/eve/v1/calls/ask", {
      method: "POST",
      headers: value === undefined ? {} : { "x-calls-secret": value },
    });
  assert.ok(hasCallsSecret(request(secret), secret));
  assert.ok(!hasCallsSecret(request("nope"), secret));
  assert.ok(!hasCallsSecret(request(), secret));
});

test("a caller's number becomes E.164, and a withheld one carries none", () => {
  assert.equal(callerNumberOf("+61412345678"), "+61412345678");
  assert.equal(callerNumberOf("+61 412 345 678"), "+61412345678");
  assert.equal(callerNumberOf("61412345678"), "+61412345678");
  assert.equal(callerNumberOf(null), null);
  assert.equal(callerNumberOf("anonymous"), null);
  assert.equal(callerNumberOf("+123"), null);
});

test("parses the initiation webhook's caller", () => {
  assert.deepEqual(
    parseCallStart({
      caller_id: "+61412345678",
      agent_id: "agent_1",
      called_number: "+61290000000",
      call_sid: "CA1",
      conversation_id: "conv_1",
    }),
    { conversationId: "conv_1", callerNumber: "+61412345678" },
  );
  assert.deepEqual(parseCallStart({ caller_id: "" }), { conversationId: null, callerNumber: null });
  assert.equal(parseCallStart("nope"), null);
});

test("parses an ask_adam call", () => {
  assert.deepEqual(
    parseCallRequest({
      request: " remind me at 5 ",
      conversation_id: "conv_1",
      caller_id: "+61412345678",
    }),
    {
      conversationId: "conv_1",
      direction: "inbound",
      callerNumber: "+61412345678",
      calledNumber: null,
      request: "remind me at 5",
    },
  );
  assert.equal(parseCallRequest({ request: "", conversation_id: "conv_1" }), null);
  assert.equal(parseCallRequest({ request: "hi" }), null);
});

test("parses a post-call transcription into a neutral call summary", () => {
  const parsed = parseCallEnded({
    type: "post_call_transcription",
    event_timestamp: 1_760_778_000,
    data: {
      agent_id: "agent_1",
      conversation_id: "conv_1",
      status: "done",
      transcript: [
        { role: "agent", message: "hey, it's Adam", time_in_call_secs: 0 },
        { role: "user", message: "remind me to call mum at 5", time_in_call_secs: 2 },
        { role: "agent", message: null, tool_calls: [{ tool_name: "ask_adam" }], time_in_call_secs: 3 },
        { role: "agent", message: "done, 5pm it is", time_in_call_secs: 6 },
      ],
      metadata: {
        start_time_unix_secs: 1_760_777_900,
        call_duration_secs: 42,
        phone_call: {
          type: "twilio",
          direction: "inbound",
          external_number: "+61412345678",
          agent_number: "+61290000000",
        },
      },
      analysis: { transcript_summary: "The user asked for a reminder to call their mum at 5pm." },
      conversation_initiation_client_data: { dynamic_variables: { local_time: "now" } },
    },
  });

  assert.deepEqual(parsed, {
    ok: true,
    ended: {
      conversationId: "conv_1",
      direction: "inbound",
      callerNumber: "+61412345678",
      calledNumber: "+61290000000",
      summary: "The user asked for a reminder to call their mum at 5pm.",
      transcript: [
        { speaker: "adam", text: "hey, it's Adam" },
        { speaker: "caller", text: "remind me to call mum at 5" },
        { speaker: "adam", text: "done, 5pm it is" },
      ],
      startedAt: "2025-10-18T08:58:20.000Z",
      durationSecs: 42,
    },
  });
});

test("a summary trusts the caller system variable over phone_call metadata", () => {
  const parsed = parseCallEnded({
    type: "post_call_transcription",
    data: {
      conversation_id: "conv_3",
      metadata: { start_time_unix_secs: "soon", phone_call: { external_number: "+61499999999" } },
      conversation_initiation_client_data: { dynamic_variables: { system__caller_id: "+61412345678" } },
    },
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.ended.callerNumber, "+61412345678");
  assert.equal(parsed.ended.summary, null);
  assert.equal(parsed.ended.startedAt, null);
});

test("a summary without a start time still parses", () => {
  const parsed = parseCallEnded({
    type: "post_call_transcription",
    data: { conversation_id: "conv_4", metadata: { call_duration_secs: 12 } },
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.ended.startedAt, null);
});

test("an ask_adam call reads the direction Adam set and the number it dialled", () => {
  assert.deepEqual(
    parseCallRequest({
      request: "what's the plan?",
      conversation_id: "conv_2",
      caller_id: "+61290000000",
      called_number: "+61412345678",
      call_direction: "outbound",
    }),
    {
      conversationId: "conv_2",
      direction: "outbound",
      callerNumber: "+61290000000",
      calledNumber: "+61412345678",
      request: "what's the plan?",
    },
  );
  assert.equal(parseCallRequest({ request: "hi", conversation_id: "c", call_direction: "sideways" }), null);
});

test("the start webhook marks every call it briefs as inbound", () => {
  const response = callStartResponse({ briefing: "b", greeting: "g", localTime: "t" });
  assert.deepEqual(response.dynamic_variables, { call_briefing: "b", greeting: "g", local_time: "t", call_direction: "inbound" });
});

test("a summary of a call Adam placed puts the owner on the called end", () => {
  const parsed = parseCallEnded({
    type: "post_call_transcription",
    data: {
      conversation_id: "conv_4",
      metadata: {
        start_time_unix_secs: 1_760_777_900,
        phone_call: { direction: "outbound", external_number: "+61412345678", agent_number: "+61290000000" },
      },
      conversation_initiation_client_data: { dynamic_variables: { call_direction: "outbound" } },
    },
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.ended.direction, "outbound");
  assert.equal(parsed.ended.calledNumber, "+61412345678");
  assert.equal(parsed.ended.callerNumber, "+61290000000");
});

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function fakeElevenLabs(numbers: unknown[], placed: unknown = { success: true, message: "ok", conversation_id: "conv_out", callSid: "CA1" }) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: init?.method ?? "GET",
      url,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/v1/convai/phone-numbers")) return Response.json(numbers);
    if (url.endsWith("/outbound-call")) return Response.json(placed);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const line = { apiKey: "xi_test", fromNumber: "+61 2 9000 0000" };
const outbound = { toNumber: "+61412345678", briefing: { briefing: "b", greeting: "Hey, it's Adam. g", localTime: "t" } };
const twilioNumber = {
  phone_number: "+61290000000",
  phone_number_id: "pn_1",
  provider: "twilio",
  assigned_agent: { agent_id: "agent_1", agent_name: "Adam" },
};

test("an outbound call goes from Adam's number, with its agent, carrying the briefing as outbound", async () => {
  const api = fakeElevenLabs([{ ...twilioNumber, phone_number: "+15550000000", phone_number_id: "pn_other" }, twilioNumber]);
  assert.deepEqual(await placeOutboundCall(line, outbound, api.fetchImpl), { conversationId: "conv_out" });

  const [list, post] = api.calls;
  assert.equal(list?.url, "https://api.elevenlabs.io/v1/convai/phone-numbers");
  assert.equal(post?.method, "POST");
  assert.equal(post?.url, "https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
  assert.equal(post?.headers["xi-api-key"], "xi_test");
  const body = post?.body as Record<string, any>;
  assert.equal(body.agent_id, "agent_1");
  assert.equal(body.agent_phone_number_id, "pn_1");
  assert.equal(body.to_number, "+61412345678");
  assert.deepEqual(body.conversation_initiation_client_data, {
    dynamic_variables: { call_briefing: "b", greeting: "Hey, it's Adam. g", local_time: "t", call_direction: "outbound" },
  });
  assert.equal(body.telephony_call_config.ringing_timeout_secs, 30);
});

test("a SIP trunk number calls out through the SIP endpoint", async () => {
  const api = fakeElevenLabs([{ ...twilioNumber, provider: "sip_trunk" }]);
  await placeOutboundCall(line, outbound, api.fetchImpl);
  assert.equal(api.calls[1]?.url, "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call");
});

test("an outbound call fails clearly before dialling when the number can't ring out", async () => {
  await assert.rejects(placeOutboundCall(line, outbound, fakeElevenLabs([]).fetchImpl), /not imported into ElevenLabs/u);
  const unassigned = fakeElevenLabs([{ ...twilioNumber, assigned_agent: null }]);
  await assert.rejects(placeOutboundCall(line, outbound, unassigned.fetchImpl), /no voice agent assigned/u);
  assert.equal(unassigned.calls.length, 1);
  const exotel = fakeElevenLabs([{ ...twilioNumber, provider: "exotel" }]);
  await assert.rejects(placeOutboundCall(line, outbound, exotel.fetchImpl), /exotel number/u);
});

test("a refusal before or by ElevenLabs means the call certainly did not go out", async () => {
  const refused = fakeElevenLabs([twilioNumber], { success: false, message: "geo permissions", conversation_id: null, callSid: null });
  await assert.rejects(placeOutboundCall(line, outbound, refused.fetchImpl), (error) =>
    error instanceof CallNotPlaced && /did not place the call: geo permissions/u.test(error.message),
  );

  const badKey = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(placeOutboundCall(line, outbound, badKey), CallNotPlaced);

  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(placeOutboundCall(line, outbound, offline), CallNotPlaced);

  const invalid = postAnswering(() => new Response("bad number", { status: 422 }));
  await assert.rejects(placeOutboundCall(line, outbound, invalid), CallNotPlaced);

  for (const missing of [fakeElevenLabs([]), fakeElevenLabs([{ ...twilioNumber, assigned_agent: null }])]) {
    await assert.rejects(placeOutboundCall(line, outbound, missing.fetchImpl), CallNotPlaced);
  }
});

function postAnswering(answer: () => Response | Promise<Response>) {
  return (async (input: string | URL | Request) =>
    String(input).endsWith("/v1/convai/phone-numbers") ? Response.json([twilioNumber]) : answer()) as typeof fetch;
}

test("a failure once the call request is sent may follow a call that went out", async () => {
  const ambiguous = [
    postAnswering(() => new Response("bad gateway", { status: 502 })),
    postAnswering(() => new Response("<html>", { status: 200 })),
    postAnswering(() => {
      throw new TypeError("socket hang up");
    }),
  ];
  for (const fetchImpl of ambiguous) {
    await assert.rejects(placeOutboundCall(line, outbound, fetchImpl), (error) => !(error instanceof CallNotPlaced));
  }
});

test("ignores other webhook events and rejects junk", () => {
  assert.deepEqual(parseCallEnded({ type: "post_call_audio", data: {} }), { ok: false, reason: "ignored" });
  assert.deepEqual(parseCallEnded({ type: "post_call_transcription" }), { ok: false, reason: "invalid" });
  assert.deepEqual(parseCallEnded(null), { ok: false, reason: "invalid" });
});
