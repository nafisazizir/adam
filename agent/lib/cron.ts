export interface LocalTime {
  hour: number;
  minute?: number;
}

const minutesPerDay = 24 * 60;

function offsetMinutes(timeZone: string, at: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/u.exec(name);
  if (!match) throw new Error(`Unrecognised UTC offset "${name}" for ${timeZone}`);
  if (!match[1]) return 0;

  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

// Cron runs in UTC, so this bakes in the zone's offset at `at` (build time). In a zone with
// daylight saving the run shifts by an hour after each change until the next deploy.
export function dailyCron(local: LocalTime, timeZone: string, at: Date = new Date()): string {
  const localMinutes = local.hour * 60 + (local.minute ?? 0);
  const utcMinutes =
    (((localMinutes - offsetMinutes(timeZone, at)) % minutesPerDay) + minutesPerDay) % minutesPerDay;
  return `${utcMinutes % 60} ${Math.floor(utcMinutes / 60)} * * *`;
}

const minuteMs = 60 * 1000;
const dayMs = minutesPerDay * minuteMs;

// The latest instant at or before `now` that a `dailyCron` expression was due. The cron Vercel runs
// was built with the offset at deploy time, which daylight saving may since have moved an hour from
// the one this instance computed, so its hour either side counts too.
export function lastDailyRun(cron: string, now: Date): Date {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/u.exec(cron);
  if (!match) throw new Error(`"${cron}" is not a daily cron like "0 21 * * *".`);
  const minuteOfDay = Number(match[2]) * 60 + Number(match[1]);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const due = [-1, 0].flatMap((day) =>
    [-60, 0, 60].map((shift) => today + day * dayMs + (minuteOfDay + shift) * minuteMs),
  );
  return new Date(Math.max(...due.filter((instant) => instant <= now.getTime())));
}
