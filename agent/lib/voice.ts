import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { waIdToE164 } from "#lib/whatsapp.js";

// WhatsApp vouches for its caller (the account that placed the call); a phone line's caller ID is
// whatever the network was told.
export type CallTransport = "whatsapp" | "phone";

export interface Caller {
  readonly transport: CallTransport;
  // E.164, or null when the call carried no usable number (withheld, or a WhatsApp username id).
  readonly number: string | null;
}

// The agent's own lines. Only a call to the configured WhatsApp number counts as a WhatsApp call;
// anything else, including an unrecognised line, is treated as the phone transport.
export interface CallLines {
  readonly whatsappPhoneNumberId?: string;
}

export interface CallStart {
  readonly conversationId: string | null;
  readonly caller: Caller;
}

export interface CallRequest {
  readonly conversationId: string;
  readonly caller: Caller;
  readonly request: string;
}

export interface CallLine {
  readonly speaker: "caller" | "adam";
  readonly text: string;
}

export interface CallEnded {
  readonly conversationId: string;
  readonly caller: Caller;
  readonly summary: string | null;
  readonly transcript: readonly CallLine[];
  readonly durationSecs: number | null;
}

export type ParsedCallEnded =
  | { readonly ok: true; readonly ended: CallEnded }
  | { readonly ok: false; readonly reason: "ignored" | "invalid" };

export interface CallBriefing {
  readonly briefing: string;
  readonly greeting: string;
  readonly localTime: string;
}

const secretHeader = "x-calls-secret";
const signatureHeader = "elevenlabs-signature";
// The ElevenLabs SDK's constructEvent accepts signatures up to 30 minutes old.
const signatureToleranceMs = 30 * 60 * 1000;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Hashing first gives equal-length buffers, so a wrong guess's length leaks nothing either.
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

export function hasCallsSecret(request: Request, secret: string): boolean {
  const given = request.headers.get(secretHeader);
  return given !== null && sameSecret(given, secret);
}

export function callEndedSignatureValid(
  header: string | null,
  rawBody: string,
  secret: string,
  now: number = Date.now(),
): boolean {
  if (!header) return false;

  const fields = new Map<string, string>();
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator > 0) fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  const timestamp = fields.get("t");
  const signature = fields.get("v0");
  if (!timestamp || !signature || !/^\d+$/u.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > signatureToleranceMs) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return sameSecret(signature, expected);
}

export function hasValidCallEndedSignature(request: Request, rawBody: string, secret: string): boolean {
  return callEndedSignatureValid(request.headers.get(signatureHeader), rawBody, secret);
}

const optionalText = z.string().nullish().transform((value) => value?.trim() || null);

const startSchema = z.object({
  caller_id: optionalText,
  called_number: optionalText,
  conversation_id: optionalText,
});

// ask_adam's body is ours to define in the ElevenLabs tool: the LLM fills `request`, and the rest
// are bound to the system dynamic variables.
const askSchema = z.object({
  request: z.string().trim().min(1).max(4000),
  conversation_id: z.string().trim().min(1),
  caller_id: optionalText,
  called_number: optionalText,
});

const endedSchema = z.object({
  type: z.literal("post_call_transcription"),
  data: z.object({
    conversation_id: z.string().min(1),
    transcript: z
      .array(z.object({ role: z.string(), message: z.string().nullish() }))
      .nullish(),
    metadata: z
      .object({
        call_duration_secs: z.number().nullish(),
        phone_call: z.object({ external_number: optionalText, agent_number: optionalText }).nullish(),
      })
      .nullish(),
    analysis: z.object({ transcript_summary: optionalText }).nullish(),
    conversation_initiation_client_data: z
      .object({ dynamic_variables: z.record(z.string(), z.unknown()).nullish() })
      .nullish(),
  }),
});

// On WhatsApp `caller_id` is the caller's wa_id (bare digits) and `called_number` the business
// number's phone number id; on a phone line they are E.164 numbers.
export function callerOf(callerId: string | null, calledNumber: string | null, lines: CallLines): Caller {
  const transport =
    lines.whatsappPhoneNumberId !== undefined && calledNumber === lines.whatsappPhoneNumberId ? "whatsapp" : "phone";
  const number = callerId ? waIdToE164(callerId.replace(/[\s().-]/gu, "")) : null;
  return { transport, number };
}

export function parseCallStart(body: unknown, lines: CallLines): CallStart | null {
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) return null;
  const { conversation_id, caller_id, called_number } = parsed.data;
  return { conversationId: conversation_id, caller: callerOf(caller_id, called_number, lines) };
}

export function parseCallRequest(body: unknown, lines: CallLines): CallRequest | null {
  const parsed = askSchema.safeParse(body);
  if (!parsed.success) return null;
  const { request, conversation_id, caller_id, called_number } = parsed.data;
  return { conversationId: conversation_id, caller: callerOf(caller_id, called_number, lines), request };
}

function variable(variables: Record<string, unknown> | null | undefined, name: string): string | null {
  const value = variables?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseCallEnded(body: unknown, lines: CallLines): ParsedCallEnded {
  const parsed = endedSchema.safeParse(body);
  if (!parsed.success) {
    const isOtherEvent =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { type?: unknown }).type === "string" &&
      (body as { type: string }).type !== "post_call_transcription";
    return { ok: false, reason: isOtherEvent ? "ignored" : "invalid" };
  }

  const { data } = parsed.data;
  const variables = data.conversation_initiation_client_data?.dynamic_variables;
  const phoneCall = data.metadata?.phone_call;
  const transcript: CallLine[] = (data.transcript ?? []).flatMap((line) => {
    const text = line.message?.trim();
    if (!text) return [];
    return [{ speaker: line.role === "agent" ? "adam" : "caller", text }];
  });

  return {
    ok: true,
    ended: {
      conversationId: data.conversation_id,
      // The same variables start and ask classify from, so all three routes agree on the transport.
      caller: callerOf(
        variable(variables, "system__caller_id") ?? phoneCall?.external_number ?? null,
        variable(variables, "system__called_number") ?? phoneCall?.agent_number ?? null,
        lines,
      ),
      summary: data.analysis?.transcript_summary ?? null,
      transcript,
      durationSecs: data.metadata?.call_duration_secs ?? null,
    },
  };
}

// Every dynamic variable the agent's prompt names must be present, so both briefings carry all three.
export function callStartResponse(briefing: CallBriefing) {
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: {
      call_briefing: briefing.briefing,
      greeting: briefing.greeting,
      local_time: briefing.localTime,
    },
  };
}

export function callReplyResponse(speech: string) {
  return { speech };
}
