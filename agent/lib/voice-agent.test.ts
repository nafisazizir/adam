import assert from "node:assert/strict";
import { test } from "node:test";

import {
  askAdamTool,
  syncVoiceAgent,
  voiceAgentConfig,
  type VoiceAgentSettings,
  type VoiceAgentState,
  type VoiceAgentStateStore,
} from "#lib/voice-agent.js";

const settings: VoiceAgentSettings = {
  apiKey: "xi_test",
  toolSecret: "calls-secret",
  startUrl: "https://adam.test/eve/v1/calls/start",
  askUrl: "https://adam.test/eve/v1/calls/ask",
  endedUrl: "https://adam.test/eve/v1/calls/ended",
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

// A tiny ElevenLabs: ids it holds answer, anything else is a 404, and every create mints an id.
function fakeElevenLabs(existing: { secrets?: string[]; tools?: string[]; agents?: string[]; webhooks?: string[] } = {}) {
  const held = {
    secrets: new Set(existing.secrets),
    tools: new Set(existing.tools),
    agents: new Set(existing.agents),
    webhooks: new Set(existing.webhooks),
  };
  let phoneNumbers: { phone_number: string; phone_number_id: string; assigned_agent: { agent_id: string } | null }[] = [];
  const calls: Call[] = [];
  let sequence = 0;
  const mint = (prefix: string) => `${prefix}_${++sequence}`;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const notFound = () => new Response("not found", { status: 404 });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    assert.equal(new Headers(init?.headers).get("xi-api-key"), "xi_test");
    calls.push({ method, path: url.pathname, body });

    const [, , , kind, id] = url.pathname.split("/");
    const resource = (name: keyof typeof held, created: () => Response) => {
      if (method === "POST") return created();
      return id && held[name].has(id) ? json({}) : notFound();
    };

    if (url.pathname.startsWith("/v1/convai/secrets")) {
      return resource("secrets", () => {
        const secretId = mint("sec");
        held.secrets.add(secretId);
        return json({ type: "stored", secret_id: secretId, name: body.name });
      });
    }
    if (url.pathname.startsWith("/v1/convai/tools")) {
      return resource("tools", () => {
        const toolId = mint("tool");
        held.tools.add(toolId);
        return json({ id: toolId });
      });
    }
    if (url.pathname === "/v1/convai/agents/create") {
      const agentId = mint("agent");
      held.agents.add(agentId);
      return json({ agent_id: agentId });
    }
    if (url.pathname.startsWith("/v1/convai/agents/")) {
      return held.agents.has(id!) ? json({}) : notFound();
    }
    if (url.pathname.startsWith("/v1/workspace/webhooks")) {
      if (method === "GET") return json({ webhooks: [...held.webhooks].map((webhook_id) => ({ webhook_id })) });
      if (method === "DELETE") {
        held.webhooks.delete(id!);
        return json({});
      }
      const webhookId = mint("hook");
      held.webhooks.add(webhookId);
      return json({ webhook_id: webhookId, webhook_secret: `whsec_${webhookId}` });
    }
    if (url.pathname === "/v1/convai/phone-numbers") {
      if (method === "GET") return json(phoneNumbers);
      const phoneId = mint("phone");
      phoneNumbers.push({ phone_number: body.phone_number, phone_number_id: phoneId, assigned_agent: { agent_id: body.agent_id } });
      return json({ phone_number_id: phoneId });
    }
    if (url.pathname.startsWith("/v1/convai/phone-numbers/")) {
      phoneNumbers = phoneNumbers.map((number) =>
        number.phone_number_id === id ? { ...number, assigned_agent: { agent_id: body.agent_id } } : number,
      );
      return json({});
    }
    throw new Error(`unexpected ${method} ${url.pathname} (${kind})`);
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    held,
    addPhoneNumber(phone_number: string, agentId: string | null) {
      phoneNumbers.push({ phone_number, phone_number_id: "phone_existing", assigned_agent: agentId ? { agent_id: agentId } : null });
    },
    phoneNumbers: () => phoneNumbers,
  };
}

function memoryStore(initial: VoiceAgentState = {}) {
  let state = initial;
  let writes = 0;
  const store: VoiceAgentStateStore = {
    async read() {
      return state;
    },
    async write(next) {
      writes += 1;
      state = next;
    },
  };
  return { store, state: () => state, writes: () => writes };
}

const creates = (calls: readonly Call[]) => calls.filter((call) => call.method === "POST").map((call) => call.path);

test("a first run creates the secret, tool, post-call webhook and agent, and saves every id", async () => {
  const api = fakeElevenLabs();
  const memory = memoryStore();
  const report = await syncVoiceAgent(settings, memory.store, api.fetchImpl);

  assert.deepEqual(creates(api.calls), [
    "/v1/convai/secrets",
    "/v1/convai/tools",
    "/v1/workspace/webhooks",
    "/v1/convai/agents/create",
  ]);
  assert.deepEqual(report.created, ["tool secret", "ask_adam tool", "post-call webhook", "agent"]);
  assert.deepEqual(memory.state(), {
    secretId: "sec_1",
    toolId: "tool_2",
    postCallWebhook: { id: "hook_3", url: settings.endedUrl, secret: "whsec_hook_3" },
    agentId: "agent_4",
  });
  assert.equal(report.phone, "not_configured");
});

test("a second run updates everything in place and creates nothing", async () => {
  const api = fakeElevenLabs();
  const memory = memoryStore();
  await syncVoiceAgent(settings, memory.store, api.fetchImpl);
  const writes = memory.writes();
  api.calls.length = 0;

  const report = await syncVoiceAgent(settings, memory.store, api.fetchImpl);
  assert.deepEqual(creates(api.calls), []);
  assert.deepEqual(report.created, []);
  assert.equal(memory.writes(), writes);
  assert.deepEqual(
    api.calls.filter((call) => call.method === "PATCH").map((call) => call.path),
    ["/v1/convai/secrets/sec_1", "/v1/convai/tools/tool_2", "/v1/convai/agents/agent_4"],
  );
  assert.deepEqual(api.calls.find((call) => call.path === "/v1/convai/secrets/sec_1")?.body, {
    type: "update",
    name: "adam-calls-tool-secret",
    value: "calls-secret",
  });
});

test("anything deleted in the dashboard is created again", async () => {
  const api = fakeElevenLabs({ secrets: ["sec_old"] });
  const memory = memoryStore({
    secretId: "sec_old",
    toolId: "tool_gone",
    agentId: "agent_gone",
    postCallWebhook: { id: "hook_gone", url: settings.endedUrl, secret: "whsec_old" },
  });
  const report = await syncVoiceAgent(settings, memory.store, api.fetchImpl);

  assert.deepEqual(report.created, ["ask_adam tool", "post-call webhook", "agent"]);
  assert.equal(memory.state().secretId, "sec_old");
  assert.equal(memory.state().postCallWebhook?.secret, "whsec_hook_2");
});

test("a new BASE_URL makes a new post-call webhook, points the agent at it, then drops the old one", async () => {
  const api = fakeElevenLabs({ secrets: ["sec_1"], tools: ["tool_1"], agents: ["agent_1"], webhooks: ["hook_old"] });
  const memory = memoryStore({
    secretId: "sec_1",
    toolId: "tool_1",
    agentId: "agent_1",
    postCallWebhook: { id: "hook_old", url: "https://old.test/eve/v1/calls/ended", secret: "whsec_old" },
  });
  const report = await syncVoiceAgent(settings, memory.store, api.fetchImpl);

  const agentPatch = api.calls.findIndex((call) => call.path === "/v1/convai/agents/agent_1");
  const deletion = api.calls.findIndex((call) => call.method === "DELETE");
  assert.ok(agentPatch >= 0 && deletion > agentPatch);
  assert.equal(report.removedWebhook, "hook_old");
  assert.ok(!api.held.webhooks.has("hook_old"));
  assert.deepEqual(memory.state().postCallWebhook, { id: "hook_1", url: settings.endedUrl, secret: "whsec_hook_1" });
});

test("the phone number is assigned to the agent, or imported from Twilio when it is not in ElevenLabs", async () => {
  const assigned = fakeElevenLabs();
  assigned.addPhoneNumber("+61 2 9000 0000", null);
  const first = await syncVoiceAgent(
    { ...settings, phoneNumber: "+61290000000" },
    memoryStore().store,
    assigned.fetchImpl,
  );
  assert.equal(first.phone, "assigned");
  assert.equal(assigned.phoneNumbers()[0]?.assigned_agent?.agent_id, first.agentId);

  const missing = fakeElevenLabs();
  const withoutTwilio = await syncVoiceAgent({ ...settings, phoneNumber: "+61290000000" }, memoryStore().store, missing.fetchImpl);
  assert.equal(withoutTwilio.phone, "not_imported");

  const imported = fakeElevenLabs();
  const report = await syncVoiceAgent(
    { ...settings, phoneNumber: "+61290000000", twilio: { accountSid: "AC1", authToken: "tok" } },
    memoryStore().store,
    imported.fetchImpl,
  );
  assert.equal(report.phone, "imported");
  assert.deepEqual(imported.calls.find((call) => call.path === "/v1/convai/phone-numbers" && call.method === "POST")?.body, {
    provider: "twilio",
    phone_number: "+61290000000",
    label: "Adam",
    sid: "AC1",
    token: "tok",
    agent_id: report.agentId,
    enable_sms: false,
  });
});

test("a failing call stops the sync with the status and keeps the ids saved so far", async () => {
  const api = fakeElevenLabs();
  const failing = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/v1/convai/tools")) return new Response("bad tool", { status: 422 });
    return api.fetchImpl(input, init);
  }) as typeof fetch;
  const memory = memoryStore();

  await assert.rejects(syncVoiceAgent(settings, memory.store, failing), /POST \/v1\/convai\/tools returned 422: bad tool/u);
  assert.deepEqual(memory.state(), { secretId: "sec_1" });
});

test("the ask_adam tool sends the secret header and binds the call's ids to system variables", () => {
  const { api_schema } = askAdamTool(settings, "sec_1").tool_config;
  assert.equal(api_schema.url, settings.askUrl);
  assert.deepEqual(api_schema.request_headers, { "x-calls-secret": { secret_id: "sec_1" } });
  assert.equal(api_schema.request_body_schema.properties.conversation_id.dynamic_variable, "system__conversation_id");
  assert.equal(api_schema.request_body_schema.properties.caller_id.dynamic_variable, "system__caller_id");
});

test("the agent takes its persona from the start webhook, needs signed urls, and leaves the voice alone unless set", () => {
  const ids = { toolId: "tool_1", secretId: "sec_1", postCallWebhookId: "hook_1" };
  const config = voiceAgentConfig(settings, ids);
  assert.equal(config.conversation_config.agent.prompt.prompt, "{{call_briefing}}");
  assert.equal(config.conversation_config.agent.first_message, "{{greeting}}");
  assert.deepEqual(Object.keys(config.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders), [
    "call_briefing",
    "greeting",
    "local_time",
  ]);
  assert.equal(config.platform_settings.auth.enable_auth, true);
  assert.equal(config.platform_settings.overrides.enable_conversation_initiation_client_data_from_webhook, true);
  assert.deepEqual(config.platform_settings.workspace_overrides.conversation_initiation_client_data_webhook, {
    url: settings.startUrl,
    request_headers: { "x-calls-secret": { secret_id: "sec_1" } },
  });
  assert.deepEqual(config.platform_settings.workspace_overrides.webhooks, {
    post_call_webhook_id: "hook_1",
    events: ["transcript"],
  });
  assert.ok(!("tts" in config.conversation_config));
  assert.deepEqual(voiceAgentConfig({ ...settings, voiceId: "voice_1" }, ids).conversation_config.tts, {
    voice_id: "voice_1",
  });
});
