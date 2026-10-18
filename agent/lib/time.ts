import { env } from "#lib/env.js";
import { localDateTimeToInstant } from "#lib/zoned-time.js";

const timeZone = env.USER_TIMEZONE;

const dateTimeFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone,
  dateStyle: "full",
  timeStyle: "short",
});

const offsetFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone,
  timeZoneName: "longOffset",
});

function offsetAt(date: Date): string {
  const part = offsetFormat
    .formatToParts(date)
    .find((entry) => entry.type === "timeZoneName");
  return part ? part.value.replace("GMT", "UTC") : "";
}

const localDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const userTimeZone = timeZone;

export function userLocalDate(now: Date = new Date()): string {
  return localDateFormat.format(now);
}

export function formatUserDateTime(date: Date): string {
  return `${dateTimeFormat.format(date)} ${offsetAt(date)}`.trim();
}

export function currentTimeContext(now: Date = new Date()): string {
  return [
    "<current_time>",
    `The user's time zone is ${timeZone}. Their local date and time right now is ${formatUserDateTime(now)}.`,
    "Interpret every date and time the user mentions in this zone, and express every date and time you report back in it too, unless they explicitly name another zone.",
    "</current_time>",
  ].join("\n");
}

export function userLocalDateTimeToInstant(local: string): Date {
  return localDateTimeToInstant(local, timeZone);
}
