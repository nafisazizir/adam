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
