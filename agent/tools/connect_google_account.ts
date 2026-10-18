import { defineTool } from "eve/tools";
import { z } from "zod";

import { ownerLinkRefusal } from "#lib/connection-auth.js";
import { google } from "#lib/google.js";
import { ownerPrincipal } from "#lib/owner.js";

export default defineTool({
  description:
    "Get a Google sign-in link that connects one of the user's Google accounts (Gmail and " +
    "Calendar, read-only), or reconnects one that needs it. Only when the user asks in chat, or " +
    "agrees to reconnect. Text them the link raw on its own line; they open it, pick the Google " +
    "account for that slot and approve. One account per link. It refuses outside the user's " +
    "direct chat with you and says why.",
  inputSchema: z.object({
    account: z
      .string()
      .optional()
      .describe(
        "Which account slot to connect, by its name from list_google_accounts (e.g. personal, work). " +
          "Leave it out only when there is a single slot.",
      ),
  }),
  label: { start: () => "Connect a Google account" },
  async execute({ account }, ctx) {
    const refusal = ownerLinkRefusal("Google sign-in", ctx.session.auth.current);
    if (refusal) return { url: null, reason: refusal };
    const signIn = await google.signIn(ownerPrincipal(ctx.session.auth.current), account);
    return { account: signIn.account, url: signIn.url, expiresAt: signIn.expiresAt?.toISOString() ?? null };
  },
});
