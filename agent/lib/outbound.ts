import { readAsset, type StoredAsset } from "#lib/assets.js";

const MEDIA_LINK = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/g;
const BUBBLE_BREAK = /^[ \t]*---[ \t]*$/m;
const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export interface OutboundFile {
  data: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface OutboundMessage {
  text: string;
  files: OutboundFile[];
  // Where the attached bytes came from, so a caller can drop what it hosted.
  sources: string[];
}

const ALLOWED_MIME_TYPES = [
  "image/",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/ogg",
];

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};

function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? mimeType.split("/")[1].split("+")[0];
}

function filenameFor(url: URL, mimeType: string): string {
  const base = url.pathname.split("/").pop() ?? "";
  if (base.includes(".")) return base;
  const stem = mimeType.startsWith("audio/") ? "audio" : "image";
  return `${stem}.${extensionFor(mimeType)}`;
}

function errorForLog(error: unknown): { message: string; name: string } {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  return { name, message: message.replace(/https?:\/\/\S+/gu, "[redacted-url]") };
}

async function fetchPublic(
  url: URL,
  signal: AbortSignal,
): Promise<StoredAsset | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;

  return {
    data: new Uint8Array(await response.arrayBuffer()),
    mimeType: (response.headers.get("content-type") ?? "").split(";")[0].trim(),
  };
}

async function fetchAttachment(rawUrl: string): Promise<OutboundFile | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    console.warn("[outbound:attachment.rejected]", { reason: "invalid-url" });
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    console.warn("[outbound:attachment.rejected]", { reason: "unsupported-protocol" });
    return null;
  }

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  // What Adam hosts is private, so it can only be read back through the seam.
  const asset =
    (await readAsset(rawUrl, signal)) ?? (await fetchPublic(url, signal));
  if (!asset) {
    console.warn("[outbound:attachment.rejected]", { reason: "unreadable" });
    return null;
  }

  const { data, mimeType } = asset;
  if (!ALLOWED_MIME_TYPES.some((allowed) => mimeType.startsWith(allowed))) {
    console.warn("[outbound:attachment.rejected]", {
      mimeType,
      reason: "unsupported-mime-type",
    });
    return null;
  }
  if (data.byteLength === 0 || data.byteLength > MAX_BYTES) {
    console.warn("[outbound:attachment.rejected]", {
      bytes: data.byteLength,
      reason: "invalid-size",
    });
    return null;
  }

  return { data, filename: filenameFor(url, mimeType), mimeType };
}

// Lone `---` lines are the bubble delimiter instructions.md teaches the model.
export function splitBubbles(message: string): string[] {
  return message
    .split(BUBBLE_BREAK)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export async function renderOutbound(message: string): Promise<OutboundMessage> {
  const matches = [...message.matchAll(MEDIA_LINK)];
  if (matches.length === 0) return { text: message, files: [], sources: [] };

  const files: OutboundFile[] = [];
  const sources: string[] = [];
  let text = message;

  for (const match of matches) {
    const file = await fetchAttachment(match[1]).catch((error: unknown) => {
      console.error("[outbound:attachment.error]", errorForLog(error));
      return null;
    });
    // Unreachable or disallowed media degrades to its raw URL rather than vanishing.
    text = text.replace(match[0], file ? "" : match[1]);
    if (file) {
      files.push(file);
      sources.push(match[1]);
    }
  }

  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), files, sources };
}
