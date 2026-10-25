import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";

import { ownerChatRefusal } from "#lib/delivery.js";
import { eventTimeInput, parseEventTime } from "#lib/event-input.js";
import { checkEventSpan, google, type GoogleOwner } from "#lib/google.js";
import { describeEvent, describeSpan } from "#lib/inbox-view.js";
import { ownerPrincipal } from "#lib/owner.js";

interface Details {
  readonly account: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly description?: string;
  readonly attendees: readonly string[];
  readonly meet: boolean;
}

type Prepared =
  | { readonly ok: true; readonly owner: GoogleOwner; readonly account: string; readonly prompt: string }
  | { readonly ok: false; readonly reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prepare(ctx: WorkflowStepToolContext, details: Details): Promise<Prepared> {
  "use step";
  const auth = ctx.session.auth.current;
  const refusal = ownerChatRefusal("Adding to the calendar", auth);
  if (refusal) return { ok: false, reason: refusal };
  const owner = ownerPrincipal(auth);
  if (!owner) return { ok: false, reason: "this turn carries no user identity" };
  try {
    const start = parseEventTime(details.start);
    const end = parseEventTime(details.end);
    checkEventSpan(start, end);
    const { account } = await google.findAccount(owner, details.account);
    const invites = details.attendees.length ? ` Google emails an invite to ${details.attendees.join(", ")}.` : "";
    const meet = details.meet ? " With a Meet link." : "";
    const prompt = `Add "${details.title}" to your ${account} calendar, ${describeSpan(start, end)}?${meet}${invites}`;
    return { ok: true, owner, account, prompt };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function create(owner: GoogleOwner, details: Details) {
  "use step";
  const event = await google.createEvent(owner, details.account, {
    title: details.title,
    start: parseEventTime(details.start),
    end: parseEventTime(details.end),
    location: details.location ?? "",
    description: details.description ?? "",
    attendees: details.attendees,
    meet: details.meet,
  });
  return describeEvent(event);
}

export default defineWorkflowTool({
  description:
    "Add an event to the main calendar of one of the user's Google accounts. Only when the user " +
    "has just asked in chat. It sends them a confirmation with the time and anyone invited first, " +
    "so do not ask again yourself. Attendees get Google's invitation email.",
  inputSchema: z.object({
    account: z.string().min(1).describe("The account whose calendar it goes on, by name (e.g. work) or address."),
    title: z.string().min(1),
    start: eventTimeInput.describe(
      "A time with the user's UTC offset, e.g. 2026-10-28T10:00:00+10:00, or a date like 2026-10-28 for all day.",
    ),
    end: eventTimeInput.describe("A time with the user's UTC offset, or for all day the last day, inclusive."),
    location: z.string().optional(),
    description: z.string().optional(),
    attendees: z.array(z.string().email()).default([]).describe("Addresses to invite."),
    meet: z.boolean().default(false).describe("Add a Google Meet link."),
  }),
  label: { start: () => "Add to the calendar" },
  async execute(details, ctx) {
    "use workflow";
    const prepared = await prepare(ctx, details);
    if (!prepared.ok) return { created: false, reason: prepared.reason };

    const answer = await ctx.ask({
      prompt: prepared.prompt,
      display: "confirmation",
      options: [
        { id: "add", label: "Add", style: "primary" },
        { id: "cancel", label: "Cancel" },
      ],
    });
    if (answer.status !== "answered" || answer.optionId !== "add") return { created: false, reason: "cancelled" };

    return { created: true, event: await create(prepared.owner, { ...details, account: prepared.account }) };
  },
});
