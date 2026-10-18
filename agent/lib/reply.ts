import { releaseAssets } from "#lib/assets.js";
import { type OutboundFile, renderOutbound, splitBubbles } from "#lib/outbound.js";

const BUBBLE_GAP_MS = 400;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Chat SDK adapters upload a Buffer, an ArrayBuffer or a Blob, never a bare Uint8Array.
export interface ReplyFile extends Omit<OutboundFile, "data"> {
  readonly data: Buffer;
}

// What differs between chat surfaces: how a bubble and a voice note are sent.
export interface ReplyTransport {
  post(bubble: { text: string; files: ReplyFile[] }): Promise<unknown>;
  sendVoice(voiceNote: ReplyFile): Promise<unknown>;
}

const asReplyFile = (file: OutboundFile): ReplyFile => ({ ...file, data: Buffer.from(file.data) });

interface CompletedMessage {
  readonly finishReason?: string;
  readonly message?: string | null;
}

interface ReplyState {
  pendingToolCallMessage?: string | null;
}

function firstNonEmptyLine(message: string): string | null {
  for (const line of message.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

// A turn that stops to call tools keeps its text as the typing status instead of sending it.
export function completedReply(event: CompletedMessage, state: ReplyState): string | null {
  if (event.finishReason === "tool-calls") {
    state.pendingToolCallMessage = event.message ? firstNonEmptyLine(event.message) : null;
    return null;
  }
  state.pendingToolCallMessage = null;
  return event.message || null;
}

// A reply lands as a few bubbles, image links become real attachments and audio a voice note.
export async function deliverReply(message: string, transport: ReplyTransport): Promise<void> {
  let posted = 0;
  const spaced = async (send: () => Promise<unknown>) => {
    if (posted > 0) await pause(BUBBLE_GAP_MS);
    await send();
    posted += 1;
  };

  for (const bubble of splitBubbles(message)) {
    const { text, files, sources } = await renderOutbound(bubble);
    const voiceNotes = files.filter((file) => file.mimeType.startsWith("audio/")).map(asReplyFile);
    const attachments = files.filter((file) => !file.mimeType.startsWith("audio/")).map(asReplyFile);

    if (text.length > 0 || attachments.length > 0) {
      await spaced(() => transport.post({ text, files: attachments }));
    }
    for (const voiceNote of voiceNotes) {
      await spaced(() => transport.sendVoice(voiceNote));
    }

    // The surface holds its own copy now, so nothing we generated stays hosted.
    await releaseAssets(sources).catch(() => {});
  }
}

export interface SignInRequest {
  readonly name: string;
  readonly authorization?: {
    readonly url?: string;
    readonly instructions?: string;
    readonly userCode?: string;
    readonly displayName?: string;
  };
}

export function signInMessage(event: SignInRequest): string | null {
  const { url, instructions, userCode, displayName } = event.authorization ?? {};
  if (!url && !instructions) return null;
  return [
    `I need you to connect ${displayName ?? event.name} before I can carry on.`,
    url,
    userCode && `Code: ${userCode}`,
    instructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// History is per surface while memory is shared, so the model must not assume it saw the rest.
export function otherSurfaceContext(surface: string): string {
  return [
    "<other_channel>",
    `The user also messages you on ${surface}. That is a separate conversation you cannot see; your memory is shared across both. If they refer to something you don't recall, it may have been said there, so ask rather than guess.`,
    "</other_channel>",
  ].join("\n");
}
