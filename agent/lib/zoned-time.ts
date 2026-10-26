const localDateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const dayMs = 24 * 60 * 60 * 1000;

function wallClockAsUtc(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(instant));
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"));
}

function offsetMs(instant: number, timeZone: string): number {
  return wallClockAsUtc(instant, timeZone) - Math.floor(instant / 60000) * 60000;
}

export function localDateTimeToInstant(local: string, timeZone: string): Date {
  const match = localDateTime.exec(local);
  if (!match) throw new Error(`"${local}" is not a local date-time like 2026-10-03T06:00.`);
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(wall).toISOString().slice(0, 16) !== local) throw new Error(`"${local}" is not a real date.`);

  const candidates = new Set([
    wall - offsetMs(wall - dayMs, timeZone),
    wall - offsetMs(wall + dayMs, timeZone),
  ]);
  const valid = [...candidates].filter((instant) => wallClockAsUtc(instant, timeZone) === wall);
  if (valid.length === 0) {
    throw new Error(`${local} does not exist in ${timeZone} (daylight saving gap); pick another time.`);
  }
  return new Date(Math.min(...valid));
}

const localDate = /^(\d{4})-(\d{2})-(\d{2})$/;

// The first instant of a local date. Where daylight saving starts at midnight there is no 00:00,
// so the day starts when the clock jumps (01:00); where 00:00 happens twice, the earlier one.
export function startOfLocalDay(date: string, timeZone: string): Date {
  const match = localDate.exec(date);
  if (!match) throw new Error(`"${date}" is not a local date like 2026-10-03.`);
  const [year, month, day] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day);
  if (new Date(wall).toISOString().slice(0, 10) !== date) throw new Error(`"${date}" is not a real date.`);

  const candidates = [wall - offsetMs(wall - dayMs, timeZone), wall - offsetMs(wall + dayMs, timeZone)];
  const onThatDay = candidates.filter((instant) => {
    const clock = wallClockAsUtc(instant, timeZone);
    return clock >= wall && clock < wall + dayMs;
  });
  return new Date(Math.min(...onThatDay));
}

export function startOfNextLocalDay(instant: Date, timeZone: string): Date {
  const today = Math.floor(wallClockAsUtc(instant.getTime(), timeZone) / dayMs) * dayMs;
  return startOfLocalDay(new Date(today + dayMs).toISOString().slice(0, 10), timeZone);
}
