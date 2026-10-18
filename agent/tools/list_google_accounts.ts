import { defineTool } from "eve/tools";
import { z } from "zod";

import { google } from "#lib/google.js";
import { ownerPrincipal } from "#lib/owner.js";

export default defineTool({
  description:
    "List the user's Google accounts by name (e.g. personal, work), the address behind each, and " +
    "whether each works or needs connecting (never signed in, or access lapsed).",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (!google.configured) return { configured: false, accounts: [] };
    return { configured: true, accounts: await google.listAccounts(ownerPrincipal(ctx.session.auth.current)) };
  },
});
