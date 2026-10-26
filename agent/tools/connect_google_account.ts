import { defineTool } from "eve/tools";
import { z } from "zod";

import { ownerLinkRefusal } from "#lib/connection-auth.js";
import { google } from "#lib/google.js";
import { stopWatchingGoogleAccount } from "#lib/google-watch.js";
import { ownerPrincipal } from "#lib/owner.js";

export default defineTool({
  description:
    "Get a Google sign-in link that adds one of the user's Google accounts (Gmail and Calendar, " +
    "read-only) under a short name, or reconnects one they already have under that name. Only when " +
    "the user asks in chat, or agrees to reconnect. Text them the link raw on its own line; they " +
    "open it, pick the Google account on Google's screen and approve. One account per link; call it " +
    "again for each further account. It refuses outside the user's direct chat with you and says why.",
  inputSchema: z.object({
    account: z
      .string()
      .min(1)
      .describe(
        "The short name for the account, from the user's words (e.g. work for 'connect my work gmail', " +
          "personal, uni). An existing name from list_google_accounts reconnects that account.",
      ),
  }),
  label: { start: () => "Connect a Google account" },
  async execute({ account }, ctx) {
    const refusal = ownerLinkRefusal("Google sign-in", ctx.session.auth.current);
    if (refusal) return { url: null, reason: refusal };
    const owner = ownerPrincipal(ctx.session.auth.current);
    // A reconnect may pick another Google account, so the old account's watches are stopped while
    // its token still works; the next listing watches whichever account the name reads then.
    const existing = owner ? await google.findAccount(owner, account).catch(() => null) : null;
    if (owner && existing) await stopWatchingGoogleAccount(owner, existing.account);
    const signIn = await google.signIn(owner, account);
    return {
      account: signIn.account,
      reconnecting: !signIn.added,
      url: signIn.url,
      expiresAt: signIn.expiresAt?.toISOString() ?? null,
    };
  },
});
