import { defineTool } from "eve/tools";
import { z } from "zod";

import { navigate } from "#lib/browser-page.js";
import { countPageOpen, currentBrowser, maxPagesPerTurn } from "#lib/operator-browser.js";
import { checkBrowsableUrl, stripPageContentTags } from "#lib/web-content.js";

export default defineTool({
  description:
    "Open an https url in the owner's logged-in browser, read-only. Returns where it landed " +
    "and the page title; call read_page next to see the content. Open only urls from your task " +
    `or links the task needs from a page you read, at most ${maxPagesPerTurn} per task.`,
  inputSchema: z.object({
    url: z.string().min(1).describe("The full https url, e.g. https://x.com/notifications."),
  }),
  label: { start: ({ url }) => `Open ${url}` },
  async execute({ url }, ctx) {
    const checked = checkBrowsableUrl(url);
    if (!checked.ok) return { opened: false, reason: checked.reason };
    if (!countPageOpen()) {
      return { opened: false, reason: `page budget of ${maxPagesPerTurn} reached; report what you have` };
    }

    const page = await navigate(await currentBrowser(ctx.session.id), checked.url);
    return {
      opened: true,
      url: page.url,
      title: stripPageContentTags(page.title),
      status: page.status,
    };
  },
});
