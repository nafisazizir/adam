import { lookup, type LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";

import type { StoredAsset } from "#lib/assets.js";

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type Octets = readonly number[];

function parseIPv4(address: string): Octets | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function parseIPv6(address: string): Octets | null {
  let text = address.split("%")[0].toLowerCase();
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (dotted) {
    const v4 = parseIPv4(dotted[2]);
    if (!v4) return null;
    text = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const split = (side: string) => (side === "" ? [] : side.split(":"));
  const head = split(halves[0]);
  const rest = halves.length === 2 ? split(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

function isPublicIPv4([a, b, c]: Octets): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function embeddedIPv4(high: number, low: number): Octets {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPublicIPv6(groups: Octets): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embedded = embeddedIPv4(g6, g7);
  if (groups.slice(0, 5).every((group) => group === 0)) return g5 === 0xffff && isPublicIPv4(embedded);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicIPv4(embedded);
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2002) return isPublicIPv4(embeddedIPv4(g1, g2));
  if (g0 === 0x2001 && g1 < 0x200) return false;
  if (g0 === 0x2001 && g1 === 0xdb8) return false;
  if (g0 === 0x3fff && g1 < 0x1000) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIPv4(parseIPv4(address) ?? []);
  if (version === 6) {
    const groups = parseIPv6(address);
    return groups !== null && isPublicIPv6(groups);
  }
  return false;
}

export function isFetchableUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  return isIP(host) === 0 || isPublicAddress(host);
}

type LookupCallback = (error: Error | null, address: string | LookupAddress[], family?: number) => void;

// Checking at connect time, rather than resolving first, leaves no window for DNS rebinding.
function publicOnlyLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void {
  lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    if (addresses.length === 0 || !addresses.every(({ address }) => isPublicAddress(address))) {
      return callback(new Error("host resolves to a non-public address"), "", 0);
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function requestOnce(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { signal, lookup: publicOnlyLookup as never, headers: { accept: "image/*,audio/*" } }, resolve)
      .on("error", reject);
  });
}

async function readCapped(response: IncomingMessage, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers["content-length"]);
  if (declared > maxBytes) {
    response.destroy();
    return null;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function fetchPublicBytes(
  start: URL,
  options: { signal: AbortSignal; maxBytes: number },
): Promise<StoredAsset | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isFetchableUrl(url)) return null;

    const response = await requestOnce(url, options.signal);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (REDIRECT_STATUSES.has(status) && location) {
      response.resume();
      url = new URL(location, url);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      return null;
    }

    const data = await readCapped(response, options.maxBytes);
    if (!data) return null;
    return { data, mimeType: (response.headers["content-type"] ?? "").split(";")[0].trim() };
  }
  return null;
}
