import { defineTool } from "eve/tools";
import { z } from "zod";

import { scrollPage } from "#lib/browser-page.js";
import { existingBrowser } from "#lib/operator-browser.js";
import { stripPageContentTags } from "#lib/web-content.js";

export default defineTool({
  description:
    "Scroll the open page by whole screens, at a human pace, so a feed loads more. Call " +
    "read_page afterwards to see what loaded.",
  inputSchema: z.object({
    direction: z.enum(["down", "up"]).default("down"),
    screens: z.number().int().min(1).max(3).default(1),
  }),
  label: { start: ({ direction }) => `Scroll ${direction}` },
  async execute({ direction, screens }) {
    const page = await scrollPage(existingBrowser(), direction, screens);
    return {
      url: page.url,
      title: stripPageContentTags(page.title),
      atTop: page.atTop,
      atBottom: page.atBottom,
    };
  },
});
