export type UrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

const privateHostSuffixes = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/u.test(hostname);
}

function isPrivateHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    !hostname.includes(".") ||
    privateHostSuffixes.some((suffix) => hostname.endsWith(suffix))
  );
}

// The URL parser has already normalised numeric spellings like 2130706433 to dotted IPv4, so
// refusing every IP literal also refuses those; a public site always has a name.
export function checkBrowsableUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "that is not a valid url" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "only https urls can be opened" };
  if (url.username || url.password) return { ok: false, reason: "urls with credentials are refused" };
  if (url.port && url.port !== "443") return { ok: false, reason: "only the default https port is allowed" };

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (isIpLiteral(hostname)) return { ok: false, reason: "open sites by name, not by IP address" };
  if (isPrivateHostname(hostname)) return { ok: false, reason: "private and local hosts are refused" };

  return { ok: true, url: url.href };
}

export const pageContentTag = "page_content";

export function stripPageContentTags(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(/<\s*\/?\s*page_content\b[^>]*>/giu, "");
    if (next === current) return current;
    current = next;
  }
}

export function tidyText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/gu, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

export interface TextWindow {
  readonly text: string;
  readonly from: number;
  readonly total: number;
  readonly nextFrom: number | null;
}

export function textWindow(text: string, from: number, maxChars: number): TextWindow {
  const start = Math.min(Math.max(0, Math.floor(from)), text.length);
  const end = Math.min(text.length, start + maxChars);
  return {
    text: text.slice(start, end),
    from: start,
    total: text.length,
    nextFrom: end < text.length ? end : null,
  };
}

export function untrustedPage(page: { url: string; title: string; body: string }): string {
  const clean = (value: string) => stripPageContentTags(value);
  return [
    `<${pageContentTag}>`,
    `url: ${clean(page.url)}`,
    `title: ${clean(page.title)}`,
    "",
    clean(page.body),
    `</${pageContentTag}>`,
  ].join("\n");
}
