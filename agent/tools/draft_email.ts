import { defineTool } from "eve/tools";
import { z } from "zod";

import { ownerChatRefusal } from "#lib/delivery.js";
import { google } from "#lib/google.js";
import { ownerPrincipal } from "#lib/owner.js";

const addresses = z.array(z.string().min(1)).default([]);

export default defineTool({
  description:
    "Save an email as a draft in one of the user's Gmail accounts, a new email or a reply in its " +
    "thread. It never sends: the user reviews it and sends it from Gmail themselves. Only when the " +
    "user asked for it in chat. Returns a link to their drafts.",
  inputSchema: z.object({
    account: z
      .string()
      .min(1)
      .describe("The account to draft in, by name (e.g. work) or address. For a reply, the account the email is in."),
    to: addresses.describe("Recipients, as an address or 'Name <address>'. A reply defaults to whoever sent it."),
    cc: addresses.describe("Cc recipients."),
    bcc: addresses.describe("Bcc recipients."),
    subject: z.string().optional().describe("The subject. Leave it out of a reply, which keeps the thread's."),
    body: z.string().min(1).describe("The plain-text body, sign-off included."),
    replyTo: z.string().min(1).optional().describe("The email id from search_email when this answers that email."),
  }),
  label: { start: () => "Draft an email" },
  async execute({ account, to, cc, bcc, subject, body, replyTo }, ctx) {
    const auth = ctx.session.auth.current;
    const refusal = ownerChatRefusal("Drafting an email", auth);
    if (refusal) return { drafted: false, reason: refusal };
    if (!replyTo && !subject) return { drafted: false, reason: "a new email needs a subject" };

    const draft = await google.createDraft(ownerPrincipal(auth), account, { to, cc, bcc, subject, body, replyTo });
    return {
      drafted: true,
      account: draft.account,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      link: draft.link,
    };
  },
});
