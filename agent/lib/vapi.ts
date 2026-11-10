import { z } from "zod";

import {
  type CallBriefing,
  type CallDirection,
  type CallEnded,
  type CallLine,
  callerNumberOf,
  CallNotPlaced,
  type CallParties,
  type CallRequest,
  type OutboundCall,
  type PlacedCall,
} from "#lib/voice.js";

const apiBase = "https://api.vapi.ai";
const askToolName = "ask_adam";
const secretHeader = "x-calls-secret";
// The relay answers within 25 seconds; Vapi's default 20 would cut Adam off.
const askTimeoutSecs = 30;
const maxCallSecs = 15 * 60;

export interface VapiLine {
  readonly apiKey: string;
  readonly phoneNumberId: string;
  readonly toolSecret: string;
  readonly toolsUrl: string;
  readonly eventsUrl: string;
  readonly elevenLabsVoiceId?: string;
}

export function vapiLine(settings: {
  readonly apiKey?: string;
  readonly phoneNumberId?: string;
  readonly toolSecret?: string;
  readonly toolsUrl: string;
  readonly eventsUrl: string;
  readonly elevenLabsVoiceId?: string;
}): VapiLine | null {
  const { apiKey, phoneNumberId, toolSecret, ...rest } = settings;
  return apiKey && phoneNumberId && toolSecret ? { apiKey, phoneNumberId, toolSecret, ...rest } : null;
}

// Adam's ElevenLabs voice when there is one, so a Vapi call sounds like an ElevenLabs one.
function vapiVoice(line: VapiLine) {
  return line.elevenLabsVoiceId
    ? { provider: "11labs", model: "eleven_flash_v2_5", voiceId: line.elevenLabsVoiceId }
    : { provider: "deepgram", model: "aura-2", voiceId: "apollo" };
}

function server(url: string, line: VapiLine, timeoutSeconds?: number) {
  return { url, headers: { [secretHeader]: line.toolSecret }, ...(timeoutSeconds && { timeoutSeconds }) };
}

// Built per call from the same briefing ElevenLabs gets, so nothing lives in the Vapi dashboard.
export function vapiAssistant(briefing: CallBriefing, line: VapiLine) {
  return {
    name: "Adam",
    firstMessage: briefing.greeting,
    firstMessageMode: "assistant-speaks-first",
    maxDurationSeconds: maxCallSecs,
    backgroundSound: "off",
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    voice: vapiVoice(line),
    model: {
      provider: "openai",
      model: "gpt-4.1-mini",
      messages: [{ role: "system", content: briefing.briefing }],
      tools: [
        {
          type: "function",
          function: {
            name: askToolName,
            description:
              "Ask Adam, the user's personal agent, to answer or do anything beyond small talk. It knows their plans, calendar, mail, reminders, notes and history, can search the web, and can text them photos and links. Returns speech: what to say back.",
            parameters: {
              type: "object",
              required: ["request"],
              properties: {
                request: {
                  type: "string",
                  description: "The user's complete, self-contained request, in their words plus any detail from the call.",
                },
              },
            },
          },
          server: server(line.toolsUrl, line, askTimeoutSecs),
        },
        { type: "endCall" },
      ],
    },
    server: server(line.eventsUrl, line),
    serverMessages: ["end-of-call-report"],
  };
}

type Fetch = typeof fetch;

const placedSchema = z.object({ id: z.string().min(1) });

// Thrown as CallNotPlaced only when Vapi refused before dialling (a 4xx); anything else may follow a
// call that went out.
export async function placeVapiCall(line: VapiLine, call: OutboundCall, fetchImpl: Fetch = fetch): Promise<PlacedCall> {
  const path = "/call";
  const response = await fetchImpl(`${apiBase}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${line.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      phoneNumberId: line.phoneNumberId,
      customer: { number: call.toNumber },
      assistant: vapiAssistant(call.briefing, line),
    }),
  });
  if (!response.ok) {
    const detail = `Vapi POST ${path} returned ${response.status}: ${(await response.text()).slice(0, 300)}`;
    if (response.status >= 400 && response.status < 500) throw new CallNotPlaced(detail);
    throw new Error(detail);
  }
  return { conversationId: placedSchema.parse(await response.json()).id };
}

const callSchema = z.object({
  id: z.string().min(1),
  type: z.string().nullish(),
  customer: z.object({ number: z.string().nullish() }).nullish(),
});

type VapiCall = z.infer<typeof callSchema>;

// Adam's own number is one end; Vapi reports the other as the customer.
function partiesOf(call: VapiCall): CallParties {
  const direction: CallDirection = call.type === "inboundPhoneCall" ? "inbound" : "outbound";
  const customer = callerNumberOf(call.customer?.number ?? null);
  return direction === "inbound"
    ? { direction, callerNumber: customer, calledNumber: null }
    : { direction, callerNumber: null, calledNumber: customer };
}

const argumentsSchema = z.union([
  z.object({ request: z.string() }),
  z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "arguments are not JSON" });
        return z.NEVER;
      }
    })
    .pipe(z.object({ request: z.string() })),
]);

const toolCallsSchema = z.object({
  message: z.object({
    type: z.literal("tool-calls"),
    call: callSchema,
    toolCallList: z.array(
      z.object({
        id: z.string().min(1),
        function: z.object({ name: z.string(), arguments: z.unknown() }),
      }),
    ),
  }),
});

export interface VapiToolCall {
  readonly toolCallId: string;
  readonly ask: CallRequest | null;
}

// Each call keeps its id so the reply goes back to the right one; anything but a well-formed
// ask_adam has no request to relay.
export function parseVapiToolCalls(body: unknown): VapiToolCall[] | null {
  const parsed = toolCallsSchema.safeParse(body);
  if (!parsed.success) return null;
  const { call, toolCallList } = parsed.data.message;
  const parties = partiesOf(call);
  return toolCallList.map((toolCall) => {
    const args = argumentsSchema.safeParse(toolCall.function.arguments);
    const request = args.success ? args.data.request.trim().slice(0, 4000) : "";
    const isAsk = toolCall.function.name === askToolName && request.length > 0;
    return { toolCallId: toolCall.id, ask: isAsk ? { ...parties, conversationId: call.id, request } : null };
  });
}

export function vapiToolResults(results: readonly { toolCallId: string; result: string }[]) {
  return { results };
}

const endedSchema = z.object({
  message: z.object({
    type: z.literal("end-of-call-report"),
    call: callSchema,
    startedAt: z.string().nullish(),
    durationSeconds: z.number().nullish(),
    analysis: z.object({ summary: z.string().nullish() }).nullish(),
    artifact: z
      .object({ messages: z.array(z.object({ role: z.string(), message: z.string().nullish() })).nullish() })
      .nullish(),
  }),
});

export type ParsedVapiEvent =
  | { readonly kind: "ended"; readonly ended: CallEnded }
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" };

function transcriptOf(messages: readonly { role: string; message?: string | null }[]): CallLine[] {
  return messages.flatMap((line): CallLine[] => {
    const text = line.message?.trim();
    if (!text) return [];
    if (line.role === "bot" || line.role === "assistant") return [{ speaker: "adam", text }];
    if (line.role === "user") return [{ speaker: "caller", text }];
    return [];
  });
}

export function parseVapiEvent(body: unknown): ParsedVapiEvent {
  const type = (body as { message?: { type?: unknown } } | null)?.message?.type;
  if (typeof type === "string" && type !== "end-of-call-report") return { kind: "ignored" };

  const parsed = endedSchema.safeParse(body);
  if (!parsed.success) return { kind: "invalid" };
  const { call, startedAt, durationSeconds, analysis, artifact } = parsed.data.message;
  return {
    kind: "ended",
    ended: {
      ...partiesOf(call),
      conversationId: call.id,
      summary: analysis?.summary?.trim() || null,
      transcript: transcriptOf(artifact?.messages ?? []),
      startedAt: startedAt ?? null,
      durationSecs: durationSeconds ?? null,
    },
  };
}
