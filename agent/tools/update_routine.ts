import { defineTool } from "eve/tools";
import { z } from "zod";

import { ownerChatRefusal } from "#lib/delivery.js";
import { recurrenceSchema } from "#lib/recurrence.js";
import { armRoutineRun, blobRoutineStore } from "#lib/routine-store.js";
import { changeRoutine, listRoutines, restoreRoutine, routineDateSchema, routineView } from "#lib/routines.js";
import { formatUserDateTime, userTimeZone } from "#lib/time.js";

export default defineTool({
  description:
    "Change a routine by id: its name, instruction or schedule, its end date, or pause and resume it. Give only " +
    "what changes. Call list_routines first to find the id. Only the user, chatting, can change one.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The routine id from list_routines."),
    name: z.string().min(1).max(60).optional(),
    instruction: z.string().min(1).max(2000).optional(),
    schedule: recurrenceSchema.optional().describe("The whole new schedule, shaped as in create_routine."),
    startsOn: routineDateSchema.optional().describe("Local date YYYY-MM-DD the new schedule counts from."),
    endsOn: routineDateSchema.nullable().optional().describe("New last local date YYYY-MM-DD, or null to run with no end."),
    paused: z.boolean().optional().describe("true pauses it; false resumes it from its next slot."),
  }),
  async execute({ id, ...patch }, ctx) {
    const refusal = ownerChatRefusal("Changing a routine", ctx.session.auth.current);
    if (refusal) throw new Error(refusal);

    const previous = (await listRoutines(blobRoutineStore)).find((routine) => routine.id === id);
    const routine = previous && (await changeRoutine(blobRoutineStore, id, patch, { now: new Date(), timeZone: userTimeZone }));
    if (!previous || !routine) return { id, updated: false, reason: "There is no routine with that id; check list_routines." };
    if (routine.nextRunAt && routine.nextRunAt !== previous.nextRunAt) {
      try {
        await armRoutineRun(routine.nextRunAt);
      } catch (error) {
        await restoreRoutine(blobRoutineStore, previous, routine);
        throw error;
      }
    }
    return routineView(routine, formatUserDateTime);
  },
});
