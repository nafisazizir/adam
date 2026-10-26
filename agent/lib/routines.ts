import { randomUUID } from "node:crypto";

import type { SessionAuthContext } from "eve/context";
import { z } from "zod";

import type { HomeOwner } from "#lib/home-target.js";
import { type DocumentStore, readDocument, updateDocument } from "#lib/json-document.js";
import { ownerAuth } from "#lib/owner.js";
import {
  describeRecurrence,
  nextOccurrence,
  type Recurrence,
  runsPerDay,
  storedRecurrenceSchema,
} from "#lib/recurrence.js";
import { untrusted } from "#lib/untrusted.js";
import { localDateOf, startOfLocalDay } from "#lib/zoned-time.js";

export const routineDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

const routineRunSchema = z.object({ at: z.string(), note: z.string(), notified: z.boolean() });

const routineSchema = z.object({
  id: z.string(),
  name: z.string(),
  instruction: z.string(),
  schedule: storedRecurrenceSchema,
  startsAt: z.string(),
  endsOn: routineDateSchema.optional(),
  paused: z.boolean(),
  nextRunAt: z.string().nullable(),
  runs: z.array(routineRunSchema),
});

export const routinesDocumentSchema = z.object({ routines: z.array(routineSchema) });
export type RoutinesDocument = z.infer<typeof routinesDocumentSchema>;
export type Routine = z.infer<typeof routineSchema>;
export type RoutineRun = z.infer<typeof routineRunSchema>;
export const noRoutines: RoutinesDocument = { routines: [] };

export const maxRoutines = 30;
// Each run writes the routines document twice (its claim and its note), so active routines may add
// up to this many runs a day: 480 of Hobby Blob's 2,000 advanced operations a month at most.
export const maxRunsPerDay = 8;
const keptRuns = 5;
// Runs due within a minute of each other go out as one turn.
const dueSlackMs = 60_000;
// A run this late (its timer was lost, or delivery was down) is skipped rather than sent hours off.
const staleAfterMs = 60 * 60_000;

export class RoutineError extends Error {}

export interface RoutineClock {
  readonly now: Date;
  readonly timeZone: string;
}

// The last slot due by now, so a run delayed past its own slot (a retried delivery) is judged by the
// slot it is late for, not skipped along with the next one.
function latestDueSlot(routine: Routine, at: string, dueBy: number, timeZone: string): number {
  let slot = Date.parse(at);
  for (let step = 0; step < 1000; step += 1) {
    const next = nextOccurrence(routine.schedule, new Date(routine.startsAt), new Date(slot), timeZone).getTime();
    if (next > dueBy) break;
    slot = next;
  }
  return slot;
}

function plannedRun(routine: Routine, clock: RoutineClock): string | null {
  const next = nextOccurrence(routine.schedule, new Date(routine.startsAt), clock.now, clock.timeZone);
  if (routine.endsOn && localDateOf(next, clock.timeZone) > routine.endsOn) return null;
  return next.toISOString();
}

function scheduled(routine: Routine, clock: RoutineClock): Routine {
  if (routine.paused) return { ...routine, nextRunAt: null };
  const nextRunAt = plannedRun(routine, clock);
  if (!nextRunAt) throw new RoutineError("That routine would end before it ever runs again; pick a later end date.");
  return { ...routine, nextRunAt };
}

function anchor(startsOn: string | undefined, clock: RoutineClock): string {
  return (startsOn ? startOfLocalDay(startsOn, clock.timeZone) : clock.now).toISOString();
}

function withinRunBudget(routines: readonly Routine[]): void {
  const perDay = routines.filter((routine) => !routine.paused).reduce((sum, routine) => sum + runsPerDay(routine.schedule), 0);
  if (perDay > maxRunsPerDay + 1e-9) {
    throw new RoutineError(
      `Together the active routines would run about ${Math.round(perDay * 10) / 10} times a day, over the limit of ${maxRunsPerDay}. Make one less frequent, or pause or delete another.`,
    );
  }
}

export interface NewRoutine {
  readonly name: string;
  readonly instruction: string;
  readonly schedule: Recurrence;
  readonly startsOn?: string;
  readonly endsOn?: string;
}

export async function addRoutine(
  store: DocumentStore<RoutinesDocument>,
  input: NewRoutine,
  clock: RoutineClock,
): Promise<Routine> {
  const routine = scheduled(
    {
      id: `routine_${randomUUID().slice(0, 8)}`,
      name: input.name,
      instruction: input.instruction,
      schedule: input.schedule,
      startsAt: anchor(input.startsOn, clock),
      ...(input.endsOn && { endsOn: input.endsOn }),
      paused: false,
      nextRunAt: null,
      runs: [],
    },
    clock,
  );
  return updateDocument(store, noRoutines, (current) => {
    if (current.routines.length >= maxRoutines) {
      throw new RoutineError(`There are already ${maxRoutines} routines; delete one before adding another.`);
    }
    const routines = [...current.routines, routine];
    withinRunBudget(routines);
    return { next: { routines }, result: routine };
  });
}

export interface RoutinePatch {
  readonly name?: string;
  readonly instruction?: string;
  readonly schedule?: Recurrence;
  readonly startsOn?: string;
  readonly endsOn?: string | null;
  readonly paused?: boolean;
}

export function changeRoutine(
  store: DocumentStore<RoutinesDocument>,
  id: string,
  patch: RoutinePatch,
  clock: RoutineClock,
): Promise<Routine | null> {
  return updateDocument(store, noRoutines, (current) => {
    const existing = current.routines.find((routine) => routine.id === id);
    if (!existing) return { next: current, result: null };

    const { endsOn: _, ...kept } = existing;
    const endsOn = patch.endsOn === undefined ? existing.endsOn : (patch.endsOn ?? undefined);
    const merged: Routine = {
      ...kept,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.instruction !== undefined && { instruction: patch.instruction }),
      ...(patch.schedule !== undefined && { schedule: patch.schedule }),
      ...(patch.paused !== undefined && { paused: patch.paused }),
      ...(endsOn && { endsOn }),
      ...((patch.schedule !== undefined || patch.startsOn !== undefined) && {
        startsAt: anchor(patch.startsOn, clock),
      }),
    };
    const timingChanged =
      patch.schedule !== undefined ||
      patch.startsOn !== undefined ||
      patch.endsOn !== undefined ||
      (patch.paused !== undefined && patch.paused !== existing.paused);
    const routine = timingChanged ? scheduled(merged, clock) : merged;
    const routines = current.routines.map((entry) => (entry.id === id ? routine : entry));
    if (timingChanged) withinRunBudget(routines);
    return { next: { routines }, result: routine };
  });
}

export function removeRoutine(store: DocumentStore<RoutinesDocument>, id: string): Promise<boolean> {
  return updateDocument(store, noRoutines, (current) => {
    if (!current.routines.some((routine) => routine.id === id)) return { next: current, result: false };
    return { next: { routines: current.routines.filter((routine) => routine.id !== id) }, result: true };
  });
}

export function recordRoutineRun(
  store: DocumentStore<RoutinesDocument>,
  id: string,
  run: RoutineRun,
): Promise<boolean> {
  return updateDocument(store, noRoutines, (current) => {
    if (!current.routines.some((routine) => routine.id === id)) return { next: current, result: false };
    return {
      next: {
        routines: current.routines.map((routine) =>
          routine.id === id ? { ...routine, runs: [...routine.runs, run].slice(-keptRuns) } : routine,
        ),
      },
      result: true,
    };
  });
}

// Through the schema, so key order (which a Blob round trip changes) cannot make equal routines differ.
function sameRoutine(a: Routine, b: Routine): boolean {
  return JSON.stringify(routineSchema.parse(a)) === JSON.stringify(routineSchema.parse(b));
}

// Only while the routine is still exactly what the update wrote, so a run claimed or noted since survives.
export function restoreRoutine(
  store: DocumentStore<RoutinesDocument>,
  previous: Routine,
  written: Routine,
): Promise<void> {
  return updateDocument(store, noRoutines, (current) => {
    const stored = current.routines.find((routine) => routine.id === previous.id);
    if (!stored || !sameRoutine(stored, written)) return { next: current, result: undefined };
    return {
      next: { routines: current.routines.map((routine) => (routine.id === previous.id ? previous : routine)) },
      result: undefined,
    };
  });
}

export async function listRoutines(store: DocumentStore<RoutinesDocument>): Promise<Routine[]> {
  return (await readDocument(store, noRoutines)).routines;
}

export interface DueRoutine {
  readonly routine: Routine;
  readonly at: string;
  readonly advancedTo: string | null;
}

export interface RoutineClaim {
  readonly due: DueRoutine[];
  readonly skipped: DueRoutine[];
  // The new run instants, each needing a timer.
  readonly arm: string[];
}

// Advancing nextRunAt is the claim: a duplicate or concurrent delivery re-reads the document and
// finds nothing left due. A routine past its end is removed with its last run.
export function claimDueRoutines(store: DocumentStore<RoutinesDocument>, clock: RoutineClock): Promise<RoutineClaim> {
  return updateDocument(store, noRoutines, (current) => {
    const now = clock.now.getTime();
    const due: DueRoutine[] = [];
    const skipped: DueRoutine[] = [];
    const routines: Routine[] = [];
    for (const routine of current.routines) {
      const at = routine.paused ? null : routine.nextRunAt;
      if (at === null || Date.parse(at) > now + dueSlackMs) {
        routines.push(routine);
        continue;
      }
      // From the later of now and the run, so a run claimed a few seconds early is not re-armed for itself.
      const advancedTo = plannedRun(routine, { ...clock, now: new Date(Math.max(now, Date.parse(at))) });
      const late = now - latestDueSlot(routine, at, now + dueSlackMs, clock.timeZone) > staleAfterMs;
      (late ? skipped : due).push({ routine, at, advancedTo });
      if (advancedTo) routines.push({ ...routine, nextRunAt: advancedTo });
    }
    const claimed = [...due, ...skipped];
    const arm = [...new Set(claimed.map((entry) => entry.advancedTo).filter((at): at is string => at !== null))];
    return { next: claimed.length ? { routines } : current, result: { due, skipped, arm } };
  });
}

// Undoes only what the claim changed, so an edit made since then survives.
export function releaseRoutines(store: DocumentStore<RoutinesDocument>, due: readonly DueRoutine[]): Promise<void> {
  return updateDocument(store, noRoutines, (current) => {
    let routines = current.routines.map((routine) => {
      const entry = due.find((claimed) => claimed.routine.id === routine.id);
      return entry && routine.nextRunAt === entry.advancedTo ? { ...routine, nextRunAt: entry.at } : routine;
    });
    const ended = due.filter(
      (entry) => entry.advancedTo === null && !routines.some((routine) => routine.id === entry.routine.id),
    );
    routines = [...routines, ...ended.map((entry) => entry.routine)];
    return { next: { routines }, result: undefined };
  });
}

export const routinesAuthenticator = "routines";

export function routineAuth(owner: HomeOwner, at: string): SessionAuthContext {
  return ownerAuth(owner, { authenticator: routinesAuthenticator, attributes: { run_at: at } });
}

export function isRoutineTurn(auth: SessionAuthContext | null | undefined): boolean {
  return auth?.authenticator === routinesAuthenticator && auth.principalType === "user";
}

export interface RoutineView {
  readonly id: string;
  readonly name: string;
  readonly instruction: string;
  readonly schedule: string;
  readonly nextRun: string | null;
  readonly paused: boolean;
  readonly endsOn?: string;
  readonly recentRuns: { at: string; note: string; notified: boolean }[];
}

export function routineView(routine: Routine, formatDateTime: (date: Date) => string): RoutineView {
  return {
    id: routine.id,
    name: routine.name,
    instruction: routine.instruction,
    schedule: describeRecurrence(routine.schedule),
    nextRun: routine.nextRunAt ? formatDateTime(new Date(routine.nextRunAt)) : null,
    paused: routine.paused,
    ...(routine.endsOn && { endsOn: routine.endsOn }),
    recentRuns: routine.runs.map((run) => ({ ...run, at: formatDateTime(new Date(run.at)) })),
  };
}

const routineTags = ["routines", "routine"];

function routineBlock(entry: DueRoutine, formatDateTime: (date: Date) => string): string {
  const { routine } = entry;
  const last = routine.runs.at(-1);
  return untrusted(
    "routine",
    {
      id: routine.id,
      name: routine.name,
      schedule: describeRecurrence(routine.schedule),
      ...(last && { last_run: formatDateTime(new Date(last.at)) }),
    },
    [
      routine.instruction,
      ...(routine.runs.length
        ? [
            "",
            "notes from earlier runs:",
            ...routine.runs.map(
              (run) => `- ${formatDateTime(new Date(run.at))} (${run.notified ? "texted" : "silent"}): ${run.note}`,
            ),
          ]
        : []),
      ...(entry.advancedTo === null ? ["", "This is its last run: it ends after today."] : []),
    ],
    routineTags,
  );
}

export function routinesMessage(
  timeContext: string,
  due: readonly DueRoutine[],
  formatDateTime: (date: Date) => string,
): string {
  return [
    timeContext,
    "",
    "<routines>",
    "Routines the user set up in chat are due now. Each carries their standing instruction: carry it out, picking up from this conversation. Notes from earlier runs say what you found or sent then: build on them and never send the same words again.",
    ...due.map((entry) => routineBlock(entry, formatDateTime)),
    "</routines>",
    "",
    "Follow your routine rules: call note_routine_run once for each routine, then text them or call the stay_silent tool.",
  ].join("\n");
}
