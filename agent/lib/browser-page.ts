import { chromium, type Page } from "playwright-core";

import type { BrowserSession } from "#lib/browser.js";
import { tidyText } from "#lib/web-content.js";

const connectTimeoutMs = 30_000;
const navigationTimeoutMs = 45_000;
const readTimeoutMs = 20_000;

export interface PageInfo {
  readonly url: string;
  readonly title: string;
}

export type ReadMode = "text" | "outline";

const scrollPosition = `({
  atTop: window.scrollY <= 0,
  atBottom: window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2,
})`;

function randomBetween(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

// Each call reconnects over CDP and disconnects afterwards; the page lives on in the hosted
// browser between tool calls, and only deleting the browser ends it.
async function withPage<T>(session: BrowserSession, use: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.connectOverCDP(session.cdpUrl, { timeout: connectTimeoutMs });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("The hosted browser has no window open.");
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(readTimeoutMs);
    return await use(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function describe(page: Page): Promise<PageInfo> {
  return { url: page.url(), title: await page.title().catch(() => "") };
}

// The pause doubles as time for client-rendered feeds to fill in, and keeps visits human-paced.
async function settle(page: Page, minMs: number, maxMs: number): Promise<void> {
  await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(randomBetween(minMs, maxMs));
}

export function navigate(session: BrowserSession, url: string): Promise<PageInfo & { status: number | null }> {
  return withPage(session, async (page) => {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await settle(page, 2_000, 5_000);
    return { ...(await describe(page)), status: response?.status() ?? null };
  });
}

export function readPage(session: BrowserSession, mode: ReadMode): Promise<PageInfo & { body: string }> {
  return withPage(session, async (page) => {
    const body =
      mode === "outline"
        ? await page.locator("body").ariaSnapshot()
        : tidyText(await page.locator("body").innerText());
    return { ...(await describe(page)), body };
  });
}

export function scrollPage(
  session: BrowserSession,
  direction: "down" | "up",
  screens: number,
): Promise<PageInfo & { atTop: boolean; atBottom: boolean }> {
  return withPage(session, async (page) => {
    const height = page.viewportSize()?.height ?? 800;
    await page.mouse.move(randomBetween(300, 900), randomBetween(200, 600));
    for (let screen = 0; screen < screens; screen += 1) {
      await page.mouse.wheel(0, (direction === "down" ? 1 : -1) * height * 0.9);
      await page.waitForTimeout(randomBetween(600, 1_400));
    }
    await settle(page, 1_500, 3_000);
    const position = await page.evaluate<{ atTop: boolean; atBottom: boolean }>(scrollPosition);
    return { ...(await describe(page)), ...position };
  });
}

export function screenshotPage(session: BrowserSession): Promise<PageInfo & { jpegBase64: string }> {
  return withPage(session, async (page) => {
    const image = await page.screenshot({ type: "jpeg", quality: 60 });
    return { ...(await describe(page)), jpegBase64: image.toString("base64") };
  });
}
