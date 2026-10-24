import { get, put } from "@vercel/blob";
import { z } from "zod";

import { env } from "#lib/env.js";
import type { VoiceAgentState, VoiceAgentStateStore } from "#lib/voice-agent.js";

const pathname = "voice-agent.json";

const stateSchema = z.object({
  agentId: z.string().min(1).optional(),
  toolId: z.string().min(1).optional(),
  secretId: z.string().min(1).optional(),
  postCallWebhook: z
    .object({ id: z.string().min(1), url: z.string().min(1), secret: z.string().min(1) })
    .optional(),
});

function token(): string {
  if (!env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob is not configured");
  return env.BLOB_READ_WRITE_TOKEN;
}

// Written only by the production build's sync, one run at a time, so a plain put is enough.
export const blobVoiceAgentStore: VoiceAgentStateStore = {
  async read() {
    const result = await get(pathname, { access: "private", token: token(), useCache: false });
    if (result === null) return {};
    if (result.statusCode !== 200) throw new Error(`voice agent state read returned ${result.statusCode}`);
    return stateSchema.parse(JSON.parse(await new Response(result.stream).text()));
  },
  async write(state: VoiceAgentState) {
    await put(pathname, JSON.stringify(state), {
      access: "private",
      token: token(),
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
    });
  },
};

export async function postCallWebhookSecret(): Promise<string | null> {
  return (await blobVoiceAgentStore.read()).postCallWebhook?.secret ?? null;
}
