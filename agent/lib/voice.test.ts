import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  callEndedSignatureValid,
  hasCallsSecret,
  parseCallEnded,
  parseCallRequest,
  callerOf,
  parseCallStart,
  sameSecret,
} from "#lib/voice.js";

const lines = { whatsappPhoneNumberId: "106540352242922" };

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

test("a call to the WhatsApp number is a WhatsApp call, and its wa_id becomes E.164", () => {
  assert.deepEqual(callerOf("61412345678", "106540352242922", lines), {
    transport: "whatsapp",
    number: "+61412345678",
  });
});

test("any other line is the phone transport, with its E.164 caller kept", () => {
  assert.deepEqual(callerOf("+61412345678", "+61290000000", lines), { transport: "phone", number: "+61412345678" });
  assert.deepEqual(callerOf("+61 412 345 678", null, lines), { transport: "phone", number: "+61412345678" });
  // A phone line that sends bare digits still compares as E.164; it never becomes WhatsApp.
  assert.deepEqual(callerOf("61412345678", "+61290000000", lines), { transport: "phone", number: "+61412345678" });
  // Without a configured WhatsApp number nothing counts as WhatsApp.
  assert.equal(callerOf("61412345678", "106540352242922", {}).transport, "phone");
});

test("withheld numbers and WhatsApp username ids carry no number", () => {
  assert.equal(callerOf(null, "+61290000000", lines).number, null);
  assert.equal(callerOf("anonymous", "+61290000000", lines).number, null);
  assert.equal(callerOf("AU.13491208655302741918", "106540352242922", lines).number, null);
});

test("parses the initiation webhook's caller", () => {
  assert.deepEqual(
    parseCallStart(
      {
        caller_id: "+61412345678",
        agent_id: "agent_1",
        called_number: "+61290000000",
        call_sid: "CA1",
        conversation_id: "conv_1",
      },
      lines,
    ),
    { conversationId: "conv_1", caller: { transport: "phone", number: "+61412345678" } },
  );
  assert.deepEqual(parseCallStart({ caller_id: "61412345678", called_number: "106540352242922" }, lines), {
    conversationId: null,
    caller: { transport: "whatsapp", number: "+61412345678" },
  });
  assert.deepEqual(parseCallStart({ caller_id: "" }, lines), {
    conversationId: null,
    caller: { transport: "phone", number: null },
  });
  assert.equal(parseCallStart("nope", lines), null);
});

test("parses an ask_adam call", () => {
  assert.deepEqual(
    parseCallRequest(
      { request: " remind me at 5 ", conversation_id: "conv_1", caller_id: "61412345678", called_number: "106540352242922" },
      lines,
    ),
    { conversationId: "conv_1", caller: { transport: "whatsapp", number: "+61412345678" }, request: "remind me at 5" },
  );
  assert.equal(parseCallRequest({ request: "", conversation_id: "conv_1" }, lines), null);
  assert.equal(parseCallRequest({ request: "hi" }, lines), null);
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
  }, lines);

  assert.deepEqual(parsed, {
    ok: true,
    ended: {
      conversationId: "conv_1",
      caller: { transport: "phone", number: "+61412345678" },
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

test("a WhatsApp call's summary takes the caller and line from the system variables", () => {
  const parsed = parseCallEnded({
    type: "post_call_transcription",
    data: {
      conversation_id: "conv_2",
      conversation_initiation_client_data: {
        dynamic_variables: { system__caller_id: "61412345678", system__called_number: "106540352242922" },
      },
    },
  }, lines);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ended.caller, { transport: "whatsapp", number: "+61412345678" });
  assert.equal(parsed.ended.summary, null);
});

test("a summary trusts the system variables over phone_call metadata for the transport", () => {
  const parsed = parseCallEnded({
    type: "post_call_transcription",
    data: {
      conversation_id: "conv_3",
      metadata: { phone_call: { external_number: "+61412345678", agent_number: "+61290000000" } },
      conversation_initiation_client_data: {
        dynamic_variables: { system__caller_id: "61412345678", system__called_number: "106540352242922" },
      },
    },
  }, lines);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ended.caller, { transport: "whatsapp", number: "+61412345678" });
});

test("ignores other webhook events and rejects junk", () => {
  assert.deepEqual(parseCallEnded({ type: "post_call_audio", data: {} }, lines), { ok: false, reason: "ignored" });
  assert.deepEqual(parseCallEnded({ type: "post_call_transcription" }, lines), { ok: false, reason: "invalid" });
  assert.deepEqual(parseCallEnded(null, lines), { ok: false, reason: "invalid" });
});
