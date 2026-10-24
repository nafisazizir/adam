// Pushes the ElevenLabs voice agent's config from this repo. `pnpm build` runs it after `eve build`,
// where it acts only on a production build; `pnpm sync:voice-agent` runs it now, against whatever
// BASE_URL the environment names. A production build never fails on it, so ElevenLabs can't block
// a deploy; a manual run does.
import { env } from "#lib/env.js";
import { syncVoiceAgent } from "#lib/voice-agent.js";
import { blobVoiceAgentStore } from "#lib/voice-agent-store.js";

const manual = process.argv.includes("--now");

function skip(reason: string): never {
  console.log(`[voice-agent] skipped: ${reason}`);
  process.exit(0);
}

if (!manual && env.deployment.environment !== "production") skip("not a production build");
if (!env.ELEVENLABS_API_KEY) skip("ELEVENLABS_API_KEY is not set");
if (!env.CALLS_TOOL_SECRET) skip("CALLS_TOOL_SECRET is not set");

try {
  const report = await syncVoiceAgent(
    {
      apiKey: env.ELEVENLABS_API_KEY,
      toolSecret: env.CALLS_TOOL_SECRET,
      startUrl: env.callsStartUrl,
      askUrl: env.callsAskUrl,
      endedUrl: env.callsEndedUrl,
      voiceId: env.ELEVENLABS_VOICE_ID,
      phoneNumber: env.CALLS_PHONE_NUMBER,
      twilio:
        env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
          ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN }
          : undefined,
    },
    blobVoiceAgentStore,
  );
  const created = report.created.length ? `created ${report.created.join(", ")}` : "nothing new";
  console.log(`[voice-agent] synced agent ${report.agentId} for ${env.BASE_URL}: ${created}; phone ${report.phone}`);
  if (report.phone === "not_imported") {
    console.warn(
      "[voice-agent] CALLS_PHONE_NUMBER is not in ElevenLabs yet; set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to import it",
    );
  }
} catch (error) {
  console.error("[voice-agent] sync failed", error);
  process.exit(manual ? 1 : 0);
}
