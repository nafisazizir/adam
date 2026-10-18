import { defineTool } from "eve/tools";
import { z } from "zod";

import { openLoginBrowser } from "#lib/browser.js";
import { navigate, OffSiteError } from "#lib/browser-page.js";
import { isOwnerDirectChat } from "#lib/delivery.js";
import { browsableUrl } from "#lib/web-content.js";

const notFromOwnerDirectChat = "Text me directly and ask again.";

export default defineTool({
  description:
    "Open the user's saved browser so they can log in to X or LinkedIn by hand, once, for the operator " +
    "to read later. Only call it when the user has just asked to connect a site in their direct chat with you. Returns " +
    "a private live-view link to text them; they log in there themselves, and when they say " +
    "they're done, call finish_browser_login. Calling it again while one is open moves the same " +
    "browser to the new site, so several sites can be logged in before finishing.",
  inputSchema: z.object({
    url: z
      .string()
      .min(1)
      .describe("The site's https login page, e.g. https://x.com/login or https://www.linkedin.com/login."),
  }),
  label: { start: ({ url }) => `Open browser login for ${url}` },
  async execute({ url }, ctx) {
    if (!isOwnerDirectChat(ctx.session.auth.current)) return { started: false, reason: notFromOwnerDirectChat };
    const checked = browsableUrl(url);
    if (!checked.ok) return { started: false, reason: checked.reason };

    const { session, created } = await openLoginBrowser(checked.url);
    if (!created) {
      try {
        await navigate(session, checked.url);
      } catch (error) {
        if (error instanceof OffSiteError) return { started: false, reason: error.message };
        throw error;
      }
    }
    if (!session.liveViewUrl) return { started: false, reason: "the browser came up without a live view" };
    return { started: true, liveViewUrl: session.liveViewUrl, expiresAfterIdleMinutes: 15 };
  },
});
