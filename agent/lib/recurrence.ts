import { z } from "zod";

import { localDateOf, localDateTimeToInstant } from "#lib/zoned-time.js";

export const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof weekdays)[number];

const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/u)
  .describe("Local 24-hour time HH:mm, e.g. 18:00.");
const interval = (max: number, unit: string) =>
  z.number().int().min(1).max(max).default(1).describe(`Every how many ${unit}; 1 for every ${unit.replace(/s$/u, "")}.`);

export const recurrenceSchema = z.discriminatedUnion("every", [
  z.object({ every: z.literal("hours"), interval: interval(168, "hours") }),
  z.object({ every: z.literal("days"), interval: interval(365, "days"), time: clockTime }),
  z.object({
    every: z.literal("weeks"),
    interval: interval(52, "weeks"),
    weekdays: z.array(z.enum(weekdays)).min(1).describe("The days of the week it runs on."),
    time: clockTime,
  }),
  z.object({
    every: z.literal("months"),
    interval: interval(12, "months"),
    day: z.number().int().min(1).max(31).describe("Day of the month; past a short month's end it runs on its last day."),
    time: clockTime,
  }),
]);

export type Recurrence = z.infer<typeof recurrenceSchema>;
type CalendarRecurrence = Exclude<Recurrence, { every: "hours" }>;

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const longestSearchDays = 800;

function dateMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function addDays(date: string, days: number): string {
  return new Date(dateMs(date) + days * dayMs).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((dateMs(to) - dateMs(from)) / dayMs);
}

function weekdayOf(date: string): Weekday {
  return weekdays[(new Date(dateMs(date)).getUTCDay() + 6) % 7];
}

function mondayOf(date: string): string {
  return addDays(date, -weekdays.indexOf(weekdayOf(date)));
}

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function daysInMonth(date: string): number {
  const month = monthIndex(date);
  return new Date(Date.UTC(Math.floor(month / 12), (month % 12) + 1, 0)).getUTCDate();
}

function runsOn(rule: CalendarRecurrence, date: string, anchorDate: string): boolean {
  switch (rule.every) {
    case "days":
      return daysBetween(anchorDate, date) % rule.interval === 0;
    case "weeks":
      return (
        rule.weekdays.includes(weekdayOf(date)) &&
        (daysBetween(mondayOf(anchorDate), mondayOf(date)) / 7) % rule.interval === 0
      );
    case "months":
      return (
        (monthIndex(date) - monthIndex(anchorDate)) % rule.interval === 0 &&
        Number(date.slice(8, 10)) === Math.min(rule.day, daysInMonth(date))
      );
  }
}

// A clock time skipped by a daylight-saving jump runs at the first minute that exists after it.
function atLocalTime(date: string, time: string, timeZone: string): Date {
  const wall = Date.parse(`${date}T${time}:00Z`);
  for (let shift = 0; shift <= 3 * hourMs; shift += 15 * 60 * 1000) {
    try {
      return localDateTimeToInstant(new Date(wall + shift).toISOString().slice(0, 16), timeZone);
    } catch {
      // inside the gap; try a little later
    }
  }
  throw new Error(`${date} ${time} does not exist in ${timeZone}.`);
}

// The first run strictly after `after` and no earlier than `anchor`: the anchor's local date counts
// as the first day, week or month of the interval, and an hourly rule first runs one interval in.
export function nextOccurrence(rule: Recurrence, anchor: Date, after: Date, timeZone: string): Date {
  if (rule.every === "hours") {
    const step = rule.interval * hourMs;
    const elapsed = after.getTime() - anchor.getTime();
    return new Date(anchor.getTime() + Math.max(1, Math.floor(elapsed / step) + 1) * step);
  }

  const anchorDate = localDateOf(anchor, timeZone);
  const from = localDateOf(after.getTime() > anchor.getTime() ? after : anchor, timeZone);
  for (let offset = 0; offset <= longestSearchDays; offset += 1) {
    const date = addDays(from, offset);
    if (!runsOn(rule, date, anchorDate)) continue;
    const instant = atLocalTime(date, rule.time, timeZone);
    if (instant.getTime() > after.getTime() && instant.getTime() >= anchor.getTime()) return instant;
  }
  throw new Error("no run found within two years; the schedule never matches");
}

const weekdayNames: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

function every(count: number, unit: string): string {
  return count === 1 ? `every ${unit}` : `every ${count} ${unit}s`;
}

export function describeRecurrence(rule: Recurrence): string {
  switch (rule.every) {
    case "hours":
      return every(rule.interval, "hour");
    case "days":
      return `${every(rule.interval, "day")} at ${rule.time}`;
    case "weeks": {
      const days = weekdays.filter((day) => rule.weekdays.includes(day)).map((day) => weekdayNames[day]);
      return `${every(rule.interval, "week")} on ${days.join(", ")} at ${rule.time}`;
    }
    case "months":
      return `${every(rule.interval, "month")} on day ${rule.day} at ${rule.time}`;
  }
}
