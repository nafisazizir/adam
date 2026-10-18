import { stripWrapperTags } from "#lib/untrusted.js";

export type UrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

// The sites the owner logs in to. Widening logged-in reading to another site is one entry here;
// public pages belong to the deep worker, which needs no login.
export const browsableSites = ["x.com", "twitter.com", "linkedin.com"] as const;

export function isBrowsableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return browsableSites.some((site) => host === site || host.endsWith(`.${site}`));
}

export function browsableUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "that is not a valid url" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "only https urls can be opened" };
  if (url.username || url.password) return { ok: false, reason: "urls with credentials are refused" };
  if (url.port && url.port !== "443") return { ok: false, reason: "only the default https port is allowed" };
  if (!isBrowsableHost(url.hostname)) {
    return {
      ok: false,
      reason: `only ${browsableSites.join(", ")} open in the logged-in browser; public pages go to deep`,
    };
  }

  return { ok: true, url: url.href };
}

export function isBrowsableUrl(raw: string): boolean {
  return browsableUrl(raw).ok;
}

export const pageContentTag = "page_content";

export function tidyText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/gu, " ").trim())
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

export function untrustedPage(page: { url: string; title: string; body?: string }): string {
  const clean = (value: string) => stripWrapperTags(value, pageContentTag);
  return [
    `<${pageContentTag}>`,
    `url: ${clean(page.url)}`,
    `title: ${clean(page.title)}`,
    ...(page.body === undefined ? [] : ["", clean(page.body)]),
    `</${pageContentTag}>`,
  ].join("\n");
}
