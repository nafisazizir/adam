import { z } from "zod";

import { env } from "#lib/env.js";

const apiBase = "https://api.onkernel.com";

const profileName = "adam-owner";
const loginBrowserName = "adam-login";
const loginTimeoutSeconds = 15 * 60;
const readingTimeoutSeconds = 5 * 60;
const viewport = { width: 1280, height: 800 };
// Kernel's stealth mode cannot be had without its CAPTCHA solver, and a solved captcha is exactly
// what the operator must stop and report instead. Off, the browser meets more bot friction.
const stealth = false;

const browserSchema = z.object({
  session_id: z.string(),
  cdp_ws_url: z.string(),
  browser_live_view_url: z.string().nullish(),
  deleted_at: z.string().nullish(),
});

const profileSchema = z.object({ id: z.string(), name: z.string().nullish() });

export interface BrowserSession {
  readonly id: string;
  readonly cdpUrl: string;
  readonly liveViewUrl: string | null;
}

export class BrowserApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function apiKey(): string {
  if (!env.KERNEL_API_KEY) {
    throw new Error("The browser is not configured: set KERNEL_API_KEY.");
  }
  return env.KERNEL_API_KEY;
}

async function kernelRequest<T extends z.ZodType>(
  path: string,
  schema: T,
  init: { method?: string; body?: unknown } = {},
): Promise<z.infer<T>> {
  const method = init.method ?? "GET";
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new BrowserApiError(`Kernel ${method} ${path} failed with ${response.status}: ${detail}`, response.status);
  }

  return schema.parse(method === "DELETE" ? {} : await response.json());
}

async function orNull<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof BrowserApiError && error.status === 404) return null;
    throw error;
  }
}

function toSession(raw: z.infer<typeof browserSchema>): BrowserSession {
  return { id: raw.session_id, cdpUrl: raw.cdp_ws_url, liveViewUrl: raw.browser_live_view_url ?? null };
}

function browserPath(idOrName: string): string {
  return `/browsers/${encodeURIComponent(idOrName)}`;
}

async function findBrowser(name: string): Promise<BrowserSession | null> {
  const raw = await orNull(kernelRequest(browserPath(name), browserSchema));
  return raw && !raw.deleted_at ? toSession(raw) : null;
}

async function profileExists(): Promise<boolean> {
  return (await orNull(kernelRequest(`/profiles/${profileName}`, profileSchema))) !== null;
}

async function ensureProfile(): Promise<void> {
  if (await profileExists()) return;
  try {
    await kernelRequest("/profiles", profileSchema, { method: "POST", body: { name: profileName } });
  } catch (error) {
    if (!(error instanceof BrowserApiError && error.status === 409)) throw error;
  }
}

// A name is unique among a project's running browsers, so creating by name makes a replayed
// create find the browser it already made instead of paying for a second one.
async function findOrCreateBrowser(
  name: string,
  options: { saveChanges: boolean; timeoutSeconds: number; startUrl?: string },
): Promise<{ session: BrowserSession; created: boolean }> {
  const existing = await findBrowser(name);
  if (existing) return { session: existing, created: false };

  let raw: z.infer<typeof browserSchema>;
  try {
    raw = await kernelRequest("/browsers", browserSchema, {
      method: "POST",
      body: {
        name,
        // Headful and the same stealth setting for reading too, so sites see the same browser
        // the owner logged in from.
        headless: false,
        stealth,
        viewport,
        timeout_seconds: options.timeoutSeconds,
        profile: { name: profileName, save_changes: options.saveChanges },
        ...(options.startUrl ? { start_url: options.startUrl } : {}),
      },
    });
  } catch (error) {
    const raced = error instanceof BrowserApiError && error.status === 409 ? await findBrowser(name) : null;
    if (raced) return { session: raced, created: false };
    throw error;
  }
  return { session: toSession(raw), created: true };
}

export async function openLoginBrowser(
  startUrl: string,
): Promise<{ session: BrowserSession; created: boolean }> {
  await ensureProfile();
  return findOrCreateBrowser(loginBrowserName, {
    saveChanges: true,
    timeoutSeconds: loginTimeoutSeconds,
    startUrl,
  });
}

// Kernel saves a profile when its writing browser is deleted, never on a CDP disconnect.
export async function finishLogin(): Promise<boolean> {
  const login = await findBrowser(loginBrowserName);
  if (!login) return false;
  await closeBrowser(login.id);
  return true;
}

export async function openReadingBrowser(key: string): Promise<BrowserSession> {
  if (!(await profileExists())) {
    throw new Error("No logged-in browser profile yet: the owner has to log in once first.");
  }
  const name = `adam-read-${key.replace(/[^\w.-]/gu, "_")}`.slice(0, 255);
  const { session } = await findOrCreateBrowser(name, {
    saveChanges: false,
    timeoutSeconds: readingTimeoutSeconds,
  });
  return session;
}

export async function closeBrowser(id: string): Promise<void> {
  await orNull(kernelRequest(browserPath(id), z.object({}), { method: "DELETE" }));
}
