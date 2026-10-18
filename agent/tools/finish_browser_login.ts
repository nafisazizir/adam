import { defineTool } from "eve/tools";
import { z } from "zod";

import { finishLogin } from "#lib/browser.js";
import { isOwnerChat } from "#lib/delivery.js";

export default defineTool({
  description:
    "Save the user's logins after they say they're done logging in through the link from " +
    "start_browser_login. It closes that browser, which is what keeps the logins for the " +
    "operator; the live-view link stops working. Only call it when the user says so in chat.",
  inputSchema: z.object({}),
  label: { start: () => "Save browser login" },
  async execute(_input, ctx) {
    if (!isOwnerChat(ctx.session.auth.current)) {
      return { saved: false, reason: "only the user can finish a login, in chat" };
    }
    const saved = await finishLogin();
    return saved
      ? { saved: true }
      : {
          saved: false,
          reason:
            "no login browser was open; one left idle for 15 minutes closes itself and keeps " +
            "what was done in it, so if they did not get to log in, start again",
        };
  },
});
