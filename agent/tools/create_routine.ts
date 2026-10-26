import { defineTool } from "eve/tools";
import { z } from "zod";

import { ownerChatRefusal } from "#lib/delivery.js";
import { recurrenceSchema } from "#lib/recurrence.js";
import { armRoutineRun, blobRoutineStore } from "#lib/routine-store.js";
import { addRoutine, removeRoutine, routineDateSchema, routineView } from "#lib/routines.js";
import { formatUserDateTime, userTimeZone } from "#lib/time.js";

export default defineTool({
  description:
    "Set up a routine: a standing instruction you carry out on a recurring schedule, landing in this chat " +
    "each time it comes due ('every other Sunday at 6pm do my health checkpoint', 'weekday mornings check " +
    "whether it'll rain on my commute'). Only when the user asks for something recurring; a one-time nudge " +
    "is schedule_reminder. Only the user, chatting, can set one up. Returns the routine with its next run.",
  inputSchema: z.object({
    name: z.string().min(1).max(60).describe("A short label the user would recognise, e.g. 'health checkpoint'."),
    instruction: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "What to do each run, written to your future self: the task, what is worth texting about, and when to stay silent.",
      ),
    schedule: recurrenceSchema.describe(
      "When it runs, in the user's time zone. 'every other Sunday at 6pm' is { every: 'weeks', interval: 2, " +
        "weekdays: ['sun'], time: '18:00' }; 'weekdays at 8' is { every: 'weeks', interval: 1, weekdays: " +
        "['mon','tue','wed','thu','fri'], time: '08:00' }; 'the 1st of every month at 9' is { every: 'months', " +
        "interval: 1, day: 1, time: '09:00' }; 'every 3 hours' is { every: 'hours', interval: 3 }.",
    ),
    startsOn: routineDateSchema
      .optional()
      .describe(
        "Local date YYYY-MM-DD the schedule counts from: the first day, week or month it can run. Omit to start now.",
      ),
    endsOn: routineDateSchema.optional().describe("Last local date YYYY-MM-DD it may run, when the user gave an end."),
  }),
  async execute(input, ctx) {
    const refusal = ownerChatRefusal("Setting up a routine", ctx.session.auth.current);
    if (refusal) throw new Error(refusal);

    const routine = await addRoutine(blobRoutineStore, input, { now: new Date(), timeZone: userTimeZone });
    try {
      await armRoutineRun(routine.nextRunAt!);
    } catch (error) {
      await removeRoutine(blobRoutineStore, routine.id);
      throw error;
    }
    return routineView(routine, formatUserDateTime);
  },
});
