import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { sameHandle } from "#lib/owner.js";

export type CallDirection = "inbound" | "outbound";

// Both ends of the line as the vendor reports them; Adam's own number is one of the two.
export interface CallParties {
  readonly direction: CallDirection;
  readonly callerNumber: string | null;
  readonly calledNumber: string | null;
}

export interface CallStart {
  readonly conversationId: string | null;
  readonly callerNumber: string | null;
}

export interface CallRequest extends CallParties {
  readonly conversationId: string;
  readonly request: string;
}

export interface CallLine {
  readonly speaker: "caller" | "adam";
  readonly text: string;
}

export interface CallEnded extends CallParties {
  readonly conversationId: string;
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

const directionSchema = z.enum(["inbound", "outbound"]);

// ask_adam's body is ours to define in the ElevenLabs tool: the LLM fills `request`, and the rest
// are bound to dynamic variables. `call_direction` is Adam's own variable: the start webhook sets it
// inbound and only an outbound call Adam places sets it outbound, so a caller can't choose it. A
// body without it comes from a tool synced before outbound calls, which only took inbound calls.
const askSchema = z.object({
  request: z.string().trim().min(1).max(4000),
  conversation_id: z.string().trim().min(1),
  caller_id: optionalText,
  called_number: optionalText,
  call_direction: directionSchema.nullish().transform((value) => value ?? "inbound"),
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
        phone_call: z
          .object({
            direction: directionSchema.nullish(),
            external_number: optionalText,
            agent_number: optionalText,
          })
          .nullish(),
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
  const { request, conversation_id, caller_id, called_number, call_direction } = parsed.data;
  return {
    conversationId: conversation_id,
    direction: call_direction,
    callerNumber: callerNumberOf(caller_id),
    calledNumber: callerNumberOf(called_number),
    request,
  };
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

  const direction =
    directionSchema.safeParse(variable(variables, "call_direction")).data ?? phoneCall?.direction ?? "inbound";
  const external = phoneCall?.external_number ?? null;
  const agent = phoneCall?.agent_number ?? null;
  const callerNumber = variable(variables, "system__caller_id") ?? (direction === "inbound" ? external : agent);
  const calledNumber = variable(variables, "system__called_number") ?? (direction === "outbound" ? external : agent);
  return {
    ok: true,
    ended: {
      conversationId: data.conversation_id,
      direction,
      // The same variables ask reads, so both routes agree on who was on the line.
      callerNumber: callerNumberOf(callerNumber),
      calledNumber: callerNumberOf(calledNumber),
      summary: data.analysis?.transcript_summary ?? null,
      transcript,
      startedAt: instantOf(data.metadata?.start_time_unix_secs),
      durationSecs: data.metadata?.call_duration_secs ?? null,
    },
  };
}

// Every dynamic variable the agent names must be present, so every briefing carries all of them.
export function callVariables(briefing: CallBriefing, direction: CallDirection) {
  return {
    call_briefing: briefing.briefing,
    greeting: briefing.greeting,
    local_time: briefing.localTime,
    call_direction: direction,
  };
}

export function callStartResponse(briefing: CallBriefing) {
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: callVariables(briefing, "inbound"),
  };
}

export function callReplyResponse(speech: string) {
  return { speech };
}

export interface OutboundLine {
  readonly apiKey: string;
  readonly fromNumber: string;
}

export interface OutboundCall {
  readonly toNumber: string;
  readonly briefing: CallBriefing;
}

export interface PlacedCall {
  readonly conversationId: string | null;
}

const apiBase = "https://api.elevenlabs.io";
// Short enough to give up before most carriers hand the call to voicemail.
const ringingTimeoutSecs = 30;

const outboundPaths = {
  twilio: "/v1/convai/twilio/outbound-call",
  sip_trunk: "/v1/convai/sip-trunk/outbound-call",
} as const;

const phoneNumbersSchema = z.array(
  z.object({
    phone_number: z.string(),
    phone_number_id: z.string(),
    provider: z.string().nullish(),
    assigned_agent: z.object({ agent_id: z.string() }).nullish(),
  }),
);

const placedSchema = z.object({
  success: z.boolean(),
  message: z.string().nullish(),
  conversation_id: z.string().nullish(),
});

type Fetch = typeof fetch;

// Thrown only when the phone certainly did not ring. Anything else from placeOutboundCall (a lost
// connection, a 5xx, a body that doesn't parse) may follow a call that went out.
export class CallNotPlaced extends Error {}

function elevenLabsRequest(
  line: OutboundLine,
  fetchImpl: Fetch,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  return fetchImpl(`${apiBase}${path}`, {
    method,
    headers: { "xi-api-key": line.apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function failure(response: Response, method: string, path: string): Promise<string> {
  return `ElevenLabs ${method} ${path} returned ${response.status}: ${(await response.text()).slice(0, 300)}`;
}

// The voice agent is whichever agent the number answers with, so an outbound call reaches the same
// agent, tool and webhooks as a call in. Nothing has dialled yet, so every failure here is certain.
async function outboundNumber(line: OutboundLine, fetchImpl: Fetch) {
  const path = "/v1/convai/phone-numbers";
  let numbers: z.infer<typeof phoneNumbersSchema>;
  try {
    const response = await elevenLabsRequest(line, fetchImpl, "GET", path);
    if (!response.ok) throw new CallNotPlaced(await failure(response, "GET", path));
    numbers = phoneNumbersSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof CallNotPlaced) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new CallNotPlaced(`could not list ElevenLabs phone numbers: ${detail}`);
  }
  const number = numbers.find((candidate) => sameHandle(candidate.phone_number, line.fromNumber));
  if (!number) throw new CallNotPlaced(`${line.fromNumber} is not imported into ElevenLabs`);
  if (!number.assigned_agent) {
    throw new CallNotPlaced(`${line.fromNumber} has no voice agent assigned in ElevenLabs yet`);
  }
  const provider = number.provider ?? "twilio";
  if (provider !== "twilio" && provider !== "sip_trunk") {
    throw new CallNotPlaced(`${line.fromNumber} is a ${provider} number, which Adam can't call out from`);
  }
  return { id: number.phone_number_id, agentId: number.assigned_agent.agent_id, path: outboundPaths[provider] };
}

// Sending the initiation data with the call means ElevenLabs skips the start webhook for it, so the
// briefing and the outbound direction come only from here.
function outboundCallBody(call: OutboundCall, number: { id: string; agentId: string }) {
  return {
    agent_id: number.agentId,
    agent_phone_number_id: number.id,
    to_number: call.toNumber,
    conversation_initiation_client_data: { dynamic_variables: callVariables(call.briefing, "outbound") },
    telephony_call_config: {
      ringing_timeout_secs: ringingTimeoutSecs,
      // A voicemail greeting would otherwise hear the briefing and be relayed to Adam as requests.
      twilio_machine_detection: {
        mode: "enable",
        actions: [{ action: "hang_up", answered_by: ["machine_start", "fax"] }],
      },
    },
  };
}

export async function placeOutboundCall(
  line: OutboundLine,
  call: OutboundCall,
  fetchImpl: Fetch = fetch,
): Promise<PlacedCall> {
  const number = await outboundNumber(line, fetchImpl);
  const response = await elevenLabsRequest(line, fetchImpl, "POST", number.path, outboundCallBody(call, number));
  // A 4xx is ElevenLabs refusing the request before dialling; a 5xx may come after it dialled.
  if (response.status >= 400 && response.status < 500) {
    throw new CallNotPlaced(await failure(response, "POST", number.path));
  }
  if (!response.ok) throw new Error(await failure(response, "POST", number.path));
  const placed = placedSchema.parse(await response.json());
  if (!placed.success) {
    throw new CallNotPlaced(`ElevenLabs did not place the call: ${placed.message ?? "no reason given"}`);
  }
  return { conversationId: placed.conversation_id ?? null };
}
