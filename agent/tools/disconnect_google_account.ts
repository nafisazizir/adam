import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";

import { ownerChatRefusal } from "#lib/delivery.js";
import { google, type GoogleDisconnect, type GoogleOwner } from "#lib/google.js";
import { forgetMailbox, stopWatchingMailbox, watchMailboxes } from "#lib/mail-watch.js";
import { ownerPrincipal } from "#lib/owner.js";

type Caller = { readonly ok: true; readonly owner: GoogleOwner } | { readonly ok: false; readonly reason: string };

type Found =
  | { readonly ok: true; readonly account: string; readonly email: string | null }
  | { readonly ok: false; readonly reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ownerInChat(ctx: WorkflowStepToolContext): Promise<Caller> {
  "use step";
  const auth = ctx.session.auth.current;
  const refusal = ownerChatRefusal("Disconnecting a Google account", auth);
  if (refusal) return { ok: false, reason: refusal };
  const owner = ownerPrincipal(auth);
  return owner ? { ok: true, owner } : { ok: false, reason: "this turn carries no user identity" };
}

async function findAccount(owner: GoogleOwner, name: string): Promise<Found> {
  "use step";
  try {
    return { ok: true, ...(await google.findAccount(owner, name)) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

// The watch is stopped while the token still works; the mailbox's state goes only once the revoke
// did, and a failed revoke restarts the watch so heads-ups continue for an account still connected.
async function disconnect(owner: GoogleOwner, account: string): Promise<GoogleDisconnect> {
  "use step";
  await stopWatchingMailbox(owner, account);
  let result: GoogleDisconnect;
  try {
    result = await google.disconnect(owner, account);
  } catch (error) {
    result = { disconnected: false, account, reason: errorMessage(error) };
  }
  if (result.disconnected) {
    await forgetMailbox(account);
    return result;
  }
  const rewatched = await watchMailboxes(owner, { accounts: [account], force: true }).catch(() => null);
  const watching = rewatched?.[account] === "watching" || rewatched?.[account] === "started";
  return watching ? { ...result, reason: `${result.reason} New-mail heads-ups for it carry on.` } : result;
}

export default defineWorkflowTool({
  description:
    "Disconnect one of the user's Google accounts: Adam stops reading its mail and calendar, and " +
    "its sign-in is revoked. Only when the user has just asked in chat. It sends them a " +
    "confirmation naming the account first, and refuses a turn the user did not start.",
  inputSchema: z.object({
    account: z.string().min(1).describe("The account, by its name from list_google_accounts or its address."),
  }),
  label: { start: () => "Disconnect a Google account" },
  async execute({ account }, ctx) {
    "use workflow";
    const caller = await ownerInChat(ctx);
    if (!caller.ok) return { disconnected: false, reason: caller.reason };

    const found = await findAccount(caller.owner, account);
    if (!found.ok) return { disconnected: false, reason: found.reason };

    const answer = await ctx.ask({
      prompt:
        `Disconnect your ${found.account} Google account${found.email ? ` (${found.email})` : ""}? ` +
        "I stop reading its mail and calendar, and connecting it again needs a new sign-in.",
      display: "confirmation",
      options: [
        { id: "disconnect", label: "Disconnect", style: "primary" },
        { id: "cancel", label: "Cancel" },
      ],
    });
    if (answer.status !== "answered" || answer.optionId !== "disconnect") {
      return { disconnected: false, account: found.account, reason: "cancelled" };
    }

    return disconnect(caller.owner, found.account);
  },
});
