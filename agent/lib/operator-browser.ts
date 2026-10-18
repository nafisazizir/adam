import { defineState } from "eve/context";

import { type BrowserSession, closeBrowser, openReadingBrowser } from "#lib/browser.js";

export const maxPagesPerTurn = 12;

const operatorBrowser = defineState<{ session: BrowserSession | null; pagesOpened: number }>(
  "adam.operator.browser",
  () => ({ session: null, pagesOpened: 0 }),
);

export async function currentBrowser(sessionId: string): Promise<BrowserSession> {
  const { session } = operatorBrowser.get();
  if (session) return session;

  const opened = await openReadingBrowser(sessionId);
  operatorBrowser.update((state) => ({ ...state, session: opened }));
  return opened;
}

export function existingBrowser(): BrowserSession {
  const { session } = operatorBrowser.get();
  if (!session) throw new Error("No page is open yet: call open_page first.");
  return session;
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
