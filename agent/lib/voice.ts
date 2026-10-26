import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export interface CallStart {
  readonly conversationId: string | null;
  readonly callerNumber: string | null;
}

export interface CallRequest {
  readonly conversationId: string;
  readonly callerNumber: string | null;
  readonly request: string;
}

export interface CallLine {
  readonly speaker: "caller" | "adam";
  readonly text: string;
}

export interface CallEnded {
  readonly conversationId: string;
  readonly callerNumber: string | null;
  readonly summary: string | null;
  readonly transcript: readonly CallLine[];
  readonly startedAt: string | null;
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
  conversation_id: optionalText,
});

// ask_adam's body is ours to define in the ElevenLabs tool: the LLM fills `request`, and the rest
// are bound to the system dynamic variables.
const askSchema = z.object({
  request: z.string().trim().min(1).max(4000),
  conversation_id: z.string().trim().min(1),
  caller_id: optionalText,
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
        start_time_unix_secs: z.unknown().optional(),
        call_duration_secs: z.number().nullish(),
        phone_call: z.object({ external_number: optionalText }).nullish(),
      })
      .nullish(),
    analysis: z.object({ transcript_summary: optionalText }).nullish(),
    conversation_initiation_client_data: z
      .object({ dynamic_variables: z.record(z.string(), z.unknown()).nullish() })
      .nullish(),
  }),
});

// Twilio sends E.164; a withheld number arrives empty or as a word such as "anonymous".
export function callerNumberOf(callerId: string | null): string | null {
  const digits = callerId?.replace(/[\s().-]/gu, "").replace(/^\+/u, "");
  return digits && /^\d{7,15}$/u.test(digits) ? `+${digits}` : null;
}

export function parseCallStart(body: unknown): CallStart | null {
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) return null;
  const { conversation_id, caller_id } = parsed.data;
  return { conversationId: conversation_id, callerNumber: callerNumberOf(caller_id) };
}

export function parseCallRequest(body: unknown): CallRequest | null {
  const parsed = askSchema.safeParse(body);
  if (!parsed.success) return null;
  const { request, conversation_id, caller_id } = parsed.data;
  return { conversationId: conversation_id, callerNumber: callerNumberOf(caller_id), request };
}

function variable(variables: Record<string, unknown> | null | undefined, name: string): string | null {
  const value = variables?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function instantOf(unixSecs: unknown): string | null {
  return typeof unixSecs === "number" && Number.isFinite(unixSecs) ? new Date(unixSecs * 1000).toISOString() : null;
}

export function parseCallEnded(body: unknown): ParsedCallEnded {
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
      // The same variable start and ask read, so all three routes agree on who called.
      callerNumber: callerNumberOf(variable(variables, "system__caller_id") ?? phoneCall?.external_number ?? null),
      summary: data.analysis?.transcript_summary ?? null,
      transcript,
      startedAt: instantOf(data.metadata?.start_time_unix_secs),
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
