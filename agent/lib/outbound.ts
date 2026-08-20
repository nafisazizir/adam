const IMAGE_LINK = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/g;
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

function extensionFor(mimeType: string): string {
  const subtype = mimeType.slice("image/".length).split("+")[0];
  return subtype === "jpeg" ? "jpg" : subtype;
}

function filenameFor(url: URL, mimeType: string): string {
  const base = url.pathname.split("/").pop() ?? "";
  return base.includes(".") ? base : `image.${extensionFor(mimeType)}`;
}

async function fetchImage(rawUrl: string): Promise<OutboundFile | null> {
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
  if (!mimeType.startsWith("image/")) return null;

  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength === 0 || data.byteLength > MAX_BYTES) return null;

  return { data, filename: filenameFor(url, mimeType), mimeType };
}

export async function renderOutbound(message: string): Promise<OutboundMessage> {
  const matches = [...message.matchAll(IMAGE_LINK)];
  if (matches.length === 0) return { text: message, files: [] };

  const files: OutboundFile[] = [];
  let text = message;

  for (const match of matches) {
    const file = await fetchImage(match[1]).catch(() => null);
    // An unreachable image degrades to its raw URL rather than vanishing.
    text = text.replace(match[0], file ? "" : match[1]);
    if (file) files.push(file);
  }

  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), files };
}
