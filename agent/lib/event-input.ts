import { z } from "zod";

import type { EventTime } from "#lib/google.js";

const dateOnly = /^\d{4}-\d{2}-\d{2}$/u;

export const eventTimeInput = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export function parseEventTime(value: string): EventTime {
  if (dateOnly.test(value)) return { allDay: true, date: value };
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error(`${value} is neither a date nor a time with its UTC offset.`);
  return { allDay: false, at };
}
