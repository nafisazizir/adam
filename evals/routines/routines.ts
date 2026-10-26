import type { Recurrence } from "#lib/recurrence.js";
import { type DueRoutine, type Routine, type RoutineRun, routinesMessage } from "#lib/routines.js";
import { currentTimeContext, formatUserDateTime } from "#lib/time.js";

export function dueRoutine(input: {
  name: string;
  instruction: string;
  schedule: Recurrence;
  runs?: RoutineRun[];
}): DueRoutine {
  const at = new Date().toISOString();
  const routine: Routine = {
    id: "routine_eval0001",
    name: input.name,
    instruction: input.instruction,
    schedule: input.schedule,
    startsAt: at,
    paused: false,
    nextRunAt: at,
    runs: input.runs ?? [],
  };
  return { routine, at, advancedTo: at };
}

export function routineTurn(...due: DueRoutine[]): string {
  return routinesMessage(currentTimeContext(), due, formatUserDateTime);
}
