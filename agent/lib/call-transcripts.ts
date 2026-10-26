import { z } from "zod";

import { callTags, transcriptLine } from "#lib/calls.js";
import { untrusted } from "#lib/untrusted.js";
import type { CallEnded, CallLine } from "#lib/voice.js";

export interface CallTranscript {
  readonly conversationId: string;
  readonly startedAt: string | null;
  readonly durationSecs: number | null;
  readonly summary: string | null;
  readonly lines: readonly CallLine[];
}

export interface SavedCall {
  readonly conversationId: string;
  readonly savedAt: Date;
}

export interface CallTranscriptStore {
  read(conversationId: string): Promise<CallTranscript | null>;
  write(transcript: CallTranscript, signal: AbortSignal): Promise<void>;
  list(): Promise<SavedCall[]>;
}

// The id names the stored file, so it must be one path segment; ElevenLabs' look like conv_01jx….
export const callTranscriptIdSchema = z.string().regex(/^[\w-]{1,128}$/u);

export function isCallTranscriptId(value: string): boolean {
  return callTranscriptIdSchema.safeParse(value).success;
}

const transcriptSchema = z.object({
  conversationId: callTranscriptIdSchema,
  startedAt: z.string().nullable(),
  durationSecs: z.number().nullable(),
  summary: z.string().nullable(),
  lines: z.array(z.object({ speaker: z.enum(["caller", "adam"]), text: z.string() })),
});

export function parseCallTranscript(text: string): CallTranscript {
  return transcriptSchema.parse(JSON.parse(text));
}

export function transcriptOf(ended: CallEnded): CallTranscript {
  return {
    conversationId: ended.conversationId,
    startedAt: ended.startedAt,
    durationSecs: ended.durationSecs,
    summary: ended.summary,
    lines: ended.transcript,
  };
}

const saveTimeoutMs = 5_000;

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// The `<call_ended>` delivery waits on this after its claim is taken, so a slow or failing store
// must cost only the transcript: a hang past the function's limit would hold the claim and lose
// the delivery too.
export async function keepCallTranscript(
  store: CallTranscriptStore,
  ended: CallEnded,
  timeoutMs: number = saveTimeoutMs,
): Promise<boolean> {
  if (!isCallTranscriptId(ended.conversationId)) {
    console.warn(`[call-transcripts] not saving ${JSON.stringify(ended.conversationId)}: not a usable id`);
    return false;
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await Promise.race([store.write(transcriptOf(ended), signal), rejectOnAbort(signal)]);
    return true;
  } catch (error) {
    console.warn(`[call-transcripts] could not save the transcript of ${ended.conversationId}`, error);
    return false;
  }
}

const maxPageChars = 12_000;
const maxLineChars = 2_000;

function clip(text: string): string {
  return text.length > maxLineChars ? `${text.slice(0, maxLineChars)}…` : text;
}

export interface TranscriptPage {
  readonly transcript: string;
  readonly lines: string;
  readonly nextLine: number | null;
}

// Pages by whole lines, always at least one, so any call reads back in bounded pieces.
export function transcriptPage(transcript: CallTranscript, fromLine: number): TranscriptPage {
  const total = transcript.lines.length;
  const start = Math.min(Math.max(0, Math.trunc(fromLine)), total);
  const body: string[] = [];
  let used = 0;

  if (start === 0 && transcript.summary) {
    const summary = `Summary: ${clip(transcript.summary)}`;
    body.push(summary, "");
    used += summary.length + 1;
  }

  let end = start;
  while (end < total) {
    const line = clip(transcriptLine(transcript.lines[end]!));
    if (end > start && used + line.length + 1 > maxPageChars) break;
    body.push(line);
    used += line.length + 1;
    end += 1;
  }
  if (total === 0) body.push("(no transcript)");

  return {
    transcript: untrusted("call_transcript", { conversation: transcript.conversationId }, body, callTags),
    lines: total === 0 ? "none" : start === end ? `none past line ${total}` : `${start + 1}-${end} of ${total}`,
    nextLine: end < total ? end : null,
  };
}

export function recentCalls(saved: readonly SavedCall[], limit: number): SavedCall[] {
  return [...saved].sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime()).slice(0, limit);
}
