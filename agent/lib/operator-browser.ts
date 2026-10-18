import { defineState } from "eve/context";

import { type BrowserSession, closeBrowser, openReadingBrowser } from "#lib/browser.js";
import { BrowserUnreachableError } from "#lib/browser-page.js";

export const maxPagesPerTurn = 12;

const operatorBrowser = defineState<{ session: BrowserSession | null; pagesOpened: number }>(
  "adam.operator.browser",
  () => ({ session: null, pagesOpened: 0 }),
);

async function currentBrowser(key: string): Promise<BrowserSession> {
  const { session } = operatorBrowser.get();
  if (session) return session;

  const opened = await openReadingBrowser(key);
  operatorBrowser.update((state) => ({ ...state, session: opened }));
  return opened;
}

async function forgetDeadBrowser(dead: BrowserSession): Promise<void> {
  operatorBrowser.update((state) => (state.session?.id === dead.id ? { ...state, session: null } : state));
  await closeBrowser(dead.id).catch(() => {});
}

// A browser Kernel has ended (idle timeout, crash) stays in state until a call fails to reach
// it; forgetting it then keeps one dead browser from wedging the rest of the turn.
export async function withBrowser<T>(key: string, run: (session: BrowserSession) => Promise<T>): Promise<T> {
  const session = await currentBrowser(key);
  try {
    return await run(session);
  } catch (error) {
    if (!(error instanceof BrowserUnreachableError)) throw error;
    await forgetDeadBrowser(session);
    return run(await currentBrowser(key));
  }
}

export async function withOpenBrowser<T>(run: (session: BrowserSession) => Promise<T>): Promise<T> {
  const { session } = operatorBrowser.get();
  if (!session) throw new Error("No page is open yet: call open_page first.");
  try {
    return await run(session);
  } catch (error) {
    if (!(error instanceof BrowserUnreachableError)) throw error;
    await forgetDeadBrowser(session);
    throw new Error("The browser had closed. Call open_page again to start a fresh one.");
  }
}

export function countPageOpen(): boolean {
  const { pagesOpened } = operatorBrowser.get();
  if (pagesOpened >= maxPagesPerTurn) return false;
  operatorBrowser.update((state) => ({ ...state, pagesOpened: state.pagesOpened + 1 }));
  return true;
}

export async function releaseBrowser(): Promise<void> {
  const { session } = operatorBrowser.get();
  operatorBrowser.update(() => ({ session: null, pagesOpened: 0 }));
  if (session) await closeBrowser(session.id);
}
