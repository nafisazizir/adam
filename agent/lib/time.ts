import { env } from "#lib/env.js";

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

export const userTimeZone = timeZone;

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
