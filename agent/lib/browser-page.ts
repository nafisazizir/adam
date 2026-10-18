import { chromium, type Page, type Request } from "playwright-core";

import type { BrowserSession } from "#lib/browser.js";
import { isBrowsableUrl, tidyText } from "#lib/web-content.js";

const connectTimeoutMs = 30_000;
const navigationTimeoutMs = 45_000;
const readTimeoutMs = 20_000;

export interface PageInfo {
  readonly url: string;
  readonly title: string;
}

export type ReadMode = "text" | "outline";

export class BrowserUnreachableError extends Error {}

export class OffSiteError extends Error {
  constructor() {
    super("The page is not on an allowed site, so it was not read. Open an allowed url instead.");
  }
}

const scrollPosition = `({
  atTop: window.scrollY <= 0,
  atBottom: window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2,
})`;

function randomBetween(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

function isMainFrameNavigation(request: Request, page: Page): boolean {
  try {
    return request.isNavigationRequest() && request.frame() === page.mainFrame();
  } catch {
    return false;
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

export function browserPages(isAllowed: (url: string) => boolean) {
  // Playwright's route sees a navigation's first request but not its redirects, so a page can
  // still land off the list; leaving it at once stops its scripts running in the logged-in browser.
  async function assertOnSite(page: Page): Promise<void> {
    const url = page.url();
    if (url === "about:blank" || isAllowed(url)) return;
    await page.goto("about:blank").catch(() => {});
    throw new OffSiteError();
  }

  // Each call reconnects over CDP and disconnects afterwards; the page lives on in the hosted
  // browser between calls, and only deleting the browser ends it. Only top-level navigations
  // are policed, so a site's own CDNs and embeds still load.
  async function withPage<T>(session: BrowserSession, use: (page: Page) => Promise<T>): Promise<T> {
    const browser = await chromium
      .connectOverCDP(session.cdpUrl, { timeout: connectTimeoutMs })
      .catch((error: unknown) => {
        throw new BrowserUnreachableError(error instanceof Error ? error.message : String(error));
      });
    try {
      const context = browser.contexts()[0];
      if (!context) throw new BrowserUnreachableError("The hosted browser has no window open.");
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(readTimeoutMs);
      await page.route("**/*", async (route) => {
        const blocked = isMainFrameNavigation(route.request(), page) && !isAllowed(route.request().url());
        await (blocked ? route.abort("blockedbyclient") : route.continue()).catch(() => {});
      });
      return await use(page);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  function navigate(session: BrowserSession, url: string): Promise<PageInfo & { status: number | null }> {
    return withPage(session, async (page) => {
      let status: number | null;
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
        status = response?.status() ?? null;
      } catch (error) {
        if (error instanceof Error && error.message.includes("ERR_BLOCKED_BY_CLIENT")) {
          await page.goto("about:blank").catch(() => {});
          throw new OffSiteError();
        }
        throw error;
      }
      await settle(page, 2_000, 5_000);
      await assertOnSite(page);
      return { ...(await describe(page)), status };
    });
  }

  function readPage(session: BrowserSession, mode: ReadMode): Promise<PageInfo & { body: string }> {
    return withPage(session, async (page) => {
      await assertOnSite(page);
      const body =
        mode === "outline"
          ? await page.locator("body").ariaSnapshot()
          : tidyText(await page.locator("body").innerText());
      return { ...(await describe(page)), body };
    });
  }

  function scrollPage(
    session: BrowserSession,
    direction: "down" | "up",
    screens: number,
  ): Promise<PageInfo & { atTop: boolean; atBottom: boolean }> {
    return withPage(session, async (page) => {
      await assertOnSite(page);
      const height = page.viewportSize()?.height ?? 800;
      await page.mouse.move(randomBetween(300, 900), randomBetween(200, 600));
      for (let screen = 0; screen < screens; screen += 1) {
        await page.mouse.wheel(0, (direction === "down" ? 1 : -1) * height * 0.9);
        await page.waitForTimeout(randomBetween(600, 1_400));
      }
      await settle(page, 1_500, 3_000);
      await assertOnSite(page);
      const position = await page.evaluate<{ atTop: boolean; atBottom: boolean }>(scrollPosition);
      return { ...(await describe(page)), ...position };
    });
  }

  function screenshotPage(session: BrowserSession): Promise<PageInfo & { jpegBase64: string }> {
    return withPage(session, async (page) => {
      await assertOnSite(page);
      const image = await page.screenshot({ type: "jpeg", quality: 60 });
      return { ...(await describe(page)), jpegBase64: image.toString("base64") };
    });
  }

  return { navigate, readPage, scrollPage, screenshotPage };
}

export const { navigate, readPage, scrollPage, screenshotPage } = browserPages(isBrowsableUrl);
