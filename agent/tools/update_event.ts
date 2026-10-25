import { defineWorkflowTool, type WorkflowStepToolContext } from "eve/tools";
import { z } from "zod";

import { ownerChatRefusal } from "#lib/delivery.js";
import { eventTimeInput, parseEventTime } from "#lib/event-input.js";
import { type EventChanges, google, type GoogleOwner } from "#lib/google.js";
import { describeEvent, describeSpan } from "#lib/inbox-view.js";
import { ownerPrincipal } from "#lib/owner.js";

interface Request {
  readonly account: string;
  readonly calendarId: string;
  readonly id: string;
  readonly title?: string;
  readonly start?: string;
  readonly end?: string;
  readonly location?: string;
  readonly description?: string;
  readonly addAttendees: readonly string[];
  readonly removeAttendees: readonly string[];
}

type Prepared =
  | { readonly ok: true; readonly owner: GoogleOwner; readonly account: string; readonly prompt: string }
  | { readonly ok: false; readonly reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function changesOf(request: Request): EventChanges {
  return {
    title: request.title,
    start: request.start === undefined ? undefined : parseEventTime(request.start),
    end: request.end === undefined ? undefined : parseEventTime(request.end),
    location: request.location,
    description: request.description,
    addAttendees: request.addAttendees,
    removeAttendees: request.removeAttendees,
  };
}

function describeChanges(request: Request, changes: EventChanges, span: string | null): string[] {
  return [
    request.title === undefined ? null : `rename it "${request.title}"`,
    span === null ? null : `move it to ${span}`,
    request.location === undefined ? null : `set the location to ${request.location || "nothing"}`,
    request.description === undefined ? null : "replace its description",
    changes.addAttendees?.length ? `invite ${changes.addAttendees.join(", ")}` : null,
    changes.removeAttendees?.length ? `uninvite ${changes.removeAttendees.join(", ")}` : null,
  ].filter((change) => change !== null);
}

async function prepare(ctx: WorkflowStepToolContext, request: Request): Promise<Prepared> {
  "use step";
  const auth = ctx.session.auth.current;
  const refusal = ownerChatRefusal("Changing a calendar event", auth);
  if (refusal) return { ok: false, reason: refusal };
  const owner = ownerPrincipal(auth);
  if (!owner) return { ok: false, reason: "this turn carries no user identity" };
  try {
    const changes = changesOf(request);
    const current = await google.getEvent(owner, request.account, request);
    const moved = changes.start || changes.end ? describeSpan(changes.start ?? current.start, changes.end ?? current.end) : null;
    const listed = describeChanges(request, changes, moved);
    if (!listed.length) return { ok: false, reason: "nothing to change was given" };
    const notified = current.attendees.length || changes.addAttendees?.length ? " Attendees get an update email." : "";
    const prompt =
      `Change "${current.title || "(untitled)"}" (${describeSpan(current.start, current.end)}) on your ` +
      `${current.account} calendar: ${listed.join(", ")}?${notified}`;
    return { ok: true, owner, account: current.account, prompt };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function update(owner: GoogleOwner, request: Request) {
  "use step";
  return describeEvent(await google.updateEvent(owner, request.account, request, changesOf(request)));
}

export default defineWorkflowTool({
  description:
    "Change an event on one of the user's Google calendars: its title, time, location, description " +
    "or who is invited. Only when the user has just asked in chat. Find the event with list_events " +
    "first. It sends them a confirmation describing the change, so do not ask again yourself. " +
    "Attendees get Google's update email.",
  inputSchema: z.object({
    account: z.string().min(1).describe("The account from list_events."),
    calendarId: z.string().min(1).default("primary").describe("The calendarId from list_events."),
    id: z.string().min(1).describe("The event id from list_events."),
    title: z.string().min(1).optional(),
    start: eventTimeInput
      .optional()
      .describe("A new start with the user's UTC offset, or a date for all day. Pass end too when it moves."),
    end: eventTimeInput.optional().describe("A new end with the user's UTC offset, or for all day the last day, inclusive."),
    location: z.string().optional(),
    description: z.string().optional(),
    addAttendees: z.array(z.string().email()).default([]).describe("Addresses to invite."),
    removeAttendees: z.array(z.string().email()).default([]).describe("Addresses to uninvite."),
  }),
  label: { start: () => "Change a calendar event" },
  async execute(request, ctx) {
    "use workflow";
    const prepared = await prepare(ctx, request);
    if (!prepared.ok) return { updated: false, reason: prepared.reason };

    const answer = await ctx.ask({
      prompt: prepared.prompt,
      display: "confirmation",
      options: [
        { id: "change", label: "Change it", style: "primary" },
        { id: "cancel", label: "Cancel" },
      ],
    });
    if (answer.status !== "answered" || answer.optionId !== "change") return { updated: false, reason: "cancelled" };

    return { updated: true, event: await update(prepared.owner, { ...request, account: prepared.account }) };
  },
});
