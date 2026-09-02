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

async function fetchAttachment(rawUrl: string): Promise<OutboundFile | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;

  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!ALLOWED_MIME_TYPES.some((allowed) => mimeType.startsWith(allowed))) return null;

  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength === 0 || data.byteLength > MAX_BYTES) return null;

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
  if (matches.length === 0) return { text: message, files: [] };

  const files: OutboundFile[] = [];
  let text = message;

  for (const match of matches) {
    const file = await fetchAttachment(match[1]).catch(() => null);
    // Unreachable or disallowed media degrades to its raw URL rather than vanishing.
    text = text.replace(match[0], file ? "" : match[1]);
    if (file) files.push(file);
  }

  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), files };
}
