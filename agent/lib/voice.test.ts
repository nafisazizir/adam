import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  callEndedSignatureValid,
  hasCallsSecret,
  parseCallEnded,
  parseCallRequest,
  callerNumberOf,
  parseCallStart,
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
    { conversationId: "conv_1", callerNumber: "+61412345678", request: "remind me at 5" },
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
      callerNumber: "+61412345678",
      summary: "The user asked for a reminder to call their mum at 5pm.",
      transcript: [
        { speaker: "adam", text: "hey, it's Adam" },
        { speaker: "caller", text: "remind me to call mum at 5" },
        { speaker: "adam", text: "done, 5pm it is" },
      ],
      durationSecs: 42,
    },
  });
});

test("a summary trusts the caller system variable over phone_call metadata", () => {
  const parsed = parseCallEnded({
    type: "post_call_transcription",
    data: {
      conversation_id: "conv_3",
      metadata: { phone_call: { external_number: "+61499999999" } },
      conversation_initiation_client_data: { dynamic_variables: { system__caller_id: "+61412345678" } },
    },
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.ended.callerNumber, "+61412345678");
  assert.equal(parsed.ended.summary, null);
});

test("ignores other webhook events and rejects junk", () => {
  assert.deepEqual(parseCallEnded({ type: "post_call_audio", data: {} }), { ok: false, reason: "ignored" });
  assert.deepEqual(parseCallEnded({ type: "post_call_transcription" }), { ok: false, reason: "invalid" });
  assert.deepEqual(parseCallEnded(null), { ok: false, reason: "invalid" });
});
