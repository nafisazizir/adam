import { callBriefing } from "#lib/calls.js";
import { sameHandle } from "#lib/owner.js";
import { callVariables } from "#lib/voice.js";

const apiBase = "https://api.elevenlabs.io";

const agentName = "Adam";
const askToolName = "ask_adam";
const toolSecretName = "adam-calls-tool-secret";
const postCallWebhookName = "Adam post-call";
// A fast model, since it only holds the conversation; Adam does the thinking behind ask_adam.
const voiceLlm = "gemini-3.5-flash";
// The ask route answers within 25 seconds; this leaves the voice agent room to speak.
const askTimeoutSecs = 30;

export interface VoiceAgentSettings {
  readonly apiKey: string;
  readonly toolSecret: string;
  readonly startUrl: string;
  readonly askUrl: string;
  readonly endedUrl: string;
  readonly voiceId?: string;
  readonly phoneNumber?: string;
}

export interface PostCallWebhook {
  readonly id: string;
  readonly url: string;
  readonly secret: string;
}

// ElevenLabs ids Adam created, so a rename in the dashboard never makes a second agent.
export interface VoiceAgentState {
  readonly agentId?: string;
  readonly toolId?: string;
  readonly secretId?: string;
  readonly postCallWebhook?: PostCallWebhook;
}

export interface VoiceAgentStateStore {
  read(): Promise<VoiceAgentState>;
  write(state: VoiceAgentState): Promise<void>;
}

export class ElevenLabsApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Fetch = typeof fetch;

function elevenLabs(apiKey: string, fetchImpl: Fetch) {
  return async function request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: { "xi-api-key": apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new ElevenLabsApiError(`${method} ${path} returned ${response.status}: ${detail}`, response.status);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  };
}

type Request = ReturnType<typeof elevenLabs>;

const secretHeader = (secretId: string) => ({ "x-calls-secret": { secret_id: secretId } });

export function askAdamTool(settings: VoiceAgentSettings, secretId: string) {
  return {
    tool_config: {
      type: "webhook",
      name: askToolName,
      description:
        "Ask Adam, the user's personal agent, to answer or do anything beyond small talk. It knows their plans, calendar, mail, reminders, notes and history, and can text them photos and links. Returns speech: what to say back.",
      response_timeout_secs: askTimeoutSecs,
      execution_mode: "immediate",
      api_schema: {
        url: settings.askUrl,
        method: "POST",
        request_headers: secretHeader(secretId),
        request_body_schema: {
          type: "object",
          required: ["request", "conversation_id", "caller_id", "called_number", "call_direction"],
          properties: {
            request: {
              type: "string",
              description: "The user's complete, self-contained request, in their words plus any detail from the call.",
            },
            conversation_id: { type: "string", dynamic_variable: "system__conversation_id" },
            caller_id: { type: "string", dynamic_variable: "system__caller_id" },
            called_number: { type: "string", dynamic_variable: "system__called_number" },
            call_direction: { type: "string", dynamic_variable: "call_direction" },
          },
        },
      },
    },
  };
}

interface AgentIds {
  readonly toolId: string;
  readonly secretId: string;
  readonly postCallWebhookId: string;
}

// The persona arrives per call from the start route, so the dashboard prompt is only its placeholder.
export function voiceAgentConfig(settings: VoiceAgentSettings, ids: AgentIds) {
  const placeholder = callBriefing("their local time");
  return {
    name: agentName,
    conversation_config: {
      agent: {
        first_message: "{{greeting}}",
        language: "en",
        dynamic_variables: {
          dynamic_variable_placeholders: callVariables(placeholder, "inbound"),
        },
        prompt: {
          prompt: "{{call_briefing}}",
          llm: voiceLlm,
          tool_ids: [ids.toolId],
          built_in_tools: { end_call: { name: "end_call", description: "", params: { system_tool_type: "end_call" } } },
        },
      },
      ...(settings.voiceId && { tts: { voice_id: settings.voiceId } }),
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: { enable_conversation_initiation_client_data_from_webhook: true },
      workspace_overrides: {
        conversation_initiation_client_data_webhook: {
          url: settings.startUrl,
          request_headers: secretHeader(ids.secretId),
        },
        webhooks: { post_call_webhook_id: ids.postCallWebhookId, events: ["transcript"] },
      },
    },
  };
}

async function syncSecret(request: Request, settings: VoiceAgentSettings, secretId: string | undefined) {
  if (secretId) {
    const updated = await request("PATCH", `/v1/convai/secrets/${secretId}`, {
      type: "update",
      name: toolSecretName,
      value: settings.toolSecret,
    });
    if (updated) return { id: secretId, created: false };
  }
  const created = await request<{ secret_id: string }>("POST", "/v1/convai/secrets", {
    type: "new",
    name: toolSecretName,
    value: settings.toolSecret,
  });
  return { id: created!.secret_id, created: true };
}

async function syncTool(request: Request, body: ReturnType<typeof askAdamTool>, toolId: string | undefined) {
  if (toolId && (await request("PATCH", `/v1/convai/tools/${toolId}`, body))) return { id: toolId, created: false };
  const created = await request<{ id: string }>("POST", "/v1/convai/tools", body);
  return { id: created!.id, created: true };
}

// A workspace webhook's url can't change and its signing secret is only shown once, at creation,
// so a new url means a new webhook.
async function syncPostCallWebhook(request: Request, url: string, current: PostCallWebhook | undefined) {
  if (current?.url === url) {
    const listed = await request<{ webhooks: { webhook_id: string }[] }>("GET", "/v1/workspace/webhooks");
    if (listed?.webhooks.some((webhook) => webhook.webhook_id === current.id)) {
      return { webhook: current, created: false };
    }
  }
  const created = await request<{ webhook_id: string; webhook_secret?: string | null }>(
    "POST",
    "/v1/workspace/webhooks",
    { settings: { auth_type: "hmac", name: postCallWebhookName, webhook_url: url } },
  );
  if (!created?.webhook_secret) throw new Error("ElevenLabs created the post-call webhook without a signing secret");
  return { webhook: { id: created.webhook_id, url, secret: created.webhook_secret }, created: true };
}

async function syncAgent(request: Request, body: ReturnType<typeof voiceAgentConfig>, agentId: string | undefined) {
  if (agentId && (await request("PATCH", `/v1/convai/agents/${agentId}`, body))) return { id: agentId, created: false };
  const created = await request<{ agent_id: string }>("POST", "/v1/convai/agents/create", body);
  return { id: created!.agent_id, created: true };
}

interface PhoneNumber {
  readonly phone_number: string;
  readonly phone_number_id: string;
  readonly assigned_agent?: { readonly agent_id: string } | null;
}

type PhoneOutcome = "assigned" | "already_assigned" | "not_imported" | "not_configured";

// The owner imports the number into ElevenLabs once, so Adam never holds Twilio credentials; the
// sync only keeps it pointed at the agent, which matters when the agent is ever recreated.
async function syncPhoneNumber(request: Request, settings: VoiceAgentSettings, agentId: string): Promise<PhoneOutcome> {
  const { phoneNumber } = settings;
  if (!phoneNumber) return "not_configured";

  const numbers = (await request<PhoneNumber[]>("GET", "/v1/convai/phone-numbers")) ?? [];
  const existing = numbers.find((number) => sameHandle(number.phone_number, phoneNumber));
  if (existing) {
    if (existing.assigned_agent?.agent_id === agentId) return "already_assigned";
    await request("PATCH", `/v1/convai/phone-numbers/${existing.phone_number_id}`, { agent_id: agentId });
    return "assigned";
  }
  return "not_imported";
}

export interface VoiceAgentSyncReport {
  readonly agentId: string;
  readonly created: readonly string[];
  readonly phone: PhoneOutcome;
  readonly removedWebhook?: string;
}

// Idempotent: each run pushes the whole config, creates only what is missing, and saves every new
// id before the next step, so a run that fails halfway is finished by the next one.
export async function syncVoiceAgent(
  settings: VoiceAgentSettings,
  store: VoiceAgentStateStore,
  fetchImpl: Fetch = fetch,
): Promise<VoiceAgentSyncReport> {
  const request = elevenLabs(settings.apiKey, fetchImpl);
  let state = await store.read();
  const created: string[] = [];
  const save = async (next: VoiceAgentState, what: string, isNew: boolean) => {
    if (isNew) created.push(what);
    if (JSON.stringify(next) !== JSON.stringify(state)) await store.write(next);
    state = next;
  };

  const secret = await syncSecret(request, settings, state.secretId);
  await save({ ...state, secretId: secret.id }, "tool secret", secret.created);

  const tool = await syncTool(request, askAdamTool(settings, secret.id), state.toolId);
  await save({ ...state, toolId: tool.id }, "ask_adam tool", tool.created);

  const previousWebhook = state.postCallWebhook;
  const webhook = await syncPostCallWebhook(request, settings.endedUrl, previousWebhook);
  await save({ ...state, postCallWebhook: webhook.webhook }, "post-call webhook", webhook.created);

  const agent = await syncAgent(
    request,
    voiceAgentConfig(settings, { toolId: tool.id, secretId: secret.id, postCallWebhookId: webhook.webhook.id }),
    state.agentId,
  );
  await save({ ...state, agentId: agent.id }, "agent", agent.created);

  let removedWebhook: string | undefined;
  if (previousWebhook && previousWebhook.id !== webhook.webhook.id) {
    await request("DELETE", `/v1/workspace/webhooks/${previousWebhook.id}`).catch((error) =>
      console.warn(`[voice-agent] could not delete the old post-call webhook ${previousWebhook.id}`, error),
    );
    removedWebhook = previousWebhook.id;
  }

  const phone = await syncPhoneNumber(request, settings, agent.id);
  return { agentId: agent.id, created, phone, ...(removedWebhook && { removedWebhook }) };
}
