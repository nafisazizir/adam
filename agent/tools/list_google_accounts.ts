import { defineTool } from "eve/tools";
import { z } from "zod";

import { google } from "#lib/google.js";
import { watchGoogleAccounts } from "#lib/google-watch.js";
import { ownerPrincipal } from "#lib/owner.js";

export default defineTool({
  description:
    "List the user's Google accounts by name (e.g. personal, work), the address behind each, and " +
    "whether each works or needs connecting (never signed in, or access lapsed).",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (!google.configured) return { configured: false, accounts: [] };
    const owner = ownerPrincipal(ctx.session.auth.current);
    const accounts = await google.listAccounts(owner);
    const connected = accounts.filter((account) => account.status === "connected").map((account) => account.account);
    // A just-(re)connected account would otherwise wait for the daily google-watch run; one already
    // watched is skipped.
    if (owner && connected.length) {
      await watchGoogleAccounts(owner, { accounts: connected }).catch((error: unknown) => {
        console.warn("[google-watch] could not start watches after listing accounts", error);
      });
    }
    return { configured: true, accounts };
  },
});
