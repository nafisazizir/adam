import { env } from "#lib/env.js";
import { configuredOutboundLine } from "#lib/ring-owner.js";
import { placeVapiCall, vapiLine } from "#lib/vapi.js";
import { type OutboundCall, type PlacedCall, placeOutboundCall } from "#lib/voice.js";

export type VoiceProviderName = typeof env.VOICE_PROVIDER;

// One line out per voice vendor; whichever is picked, the call lands in the same thread.
export interface VoiceLine {
  readonly provider: VoiceProviderName;
  readonly place: (call: OutboundCall) => Promise<PlacedCall>;
}

export function configuredVapiLine() {
  return vapiLine({
    apiKey: env.VAPI_API_KEY,
    phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
    toolSecret: env.CALLS_TOOL_SECRET,
    toolsUrl: env.vapiToolsUrl,
    eventsUrl: env.vapiEventsUrl,
  });
}

export function configuredVoiceLine(provider: VoiceProviderName = env.VOICE_PROVIDER): VoiceLine | null {
  if (provider === "vapi") {
    const line = configuredVapiLine();
    return line && { provider, place: (call) => placeVapiCall(line, call) };
  }
  const line = configuredOutboundLine();
  return line && { provider, place: (call) => placeOutboundCall(line, call) };
}

export function placeOnLine(line: VoiceLine, call: OutboundCall): Promise<PlacedCall> {
  return line.place(call);
}
