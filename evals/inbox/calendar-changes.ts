import type { CalendarChange } from "#lib/calendar-changes.js";
import type { CalendarEvent } from "#lib/google.js";

const hoursFromNow = (hours: number) => ({ allDay: false as const, at: new Date(Date.now() + hours * 60 * 60 * 1000) });

function event(id: string, startHours: number, fields: Partial<CalendarEvent>): CalendarEvent {
  return {
    account: "work",
    calendar: "work",
    calendarId: "primary",
    id,
    title: "",
    start: hoursFromNow(startHours),
    end: hoursFromNow(startHours + 1),
    location: "",
    description: "",
    organizer: "",
    attendees: [],
    myResponse: null,
    link: null,
    meetLink: null,
    ...fields,
  };
}

export const routineChanges: CalendarChange[] = [
  {
    kind: "declined",
    updated: "u1",
    declinedBy: ["Priya Raman <priya@corp.example>"],
    event: event("sync", 24 * 6, {
      title: "Team sync",
      attendees: [
        "Priya Raman <priya@corp.example>",
        "Tom Ng <tom@corp.example>",
        "Lena Park <lena@corp.example>",
        "Omar Haddad <omar@corp.example>",
        "Grace Liu <grace@corp.example>",
        "Ben Carter <ben@corp.example>",
        "Sofia Rossi <sofia@corp.example>",
      ],
    }),
  },
  {
    kind: "changed",
    updated: "u2",
    time: true,
    place: false,
    was: { start: hoursFromNow(24 * 9), end: hoursFromNow(24 * 9 + 1) },
    event: event("webinar", 24 * 9 + 0.25, {
      title: "Webinar: Scaling Postgres in 2027",
      organizer: "DataConf Events <events@dataconf.example>",
      myResponse: "needsAction",
    }),
  },
];

const personal = { account: "personal", calendar: "personal" };

export const tonightCancelled: CalendarChange[] = [
  {
    kind: "declined",
    updated: "u4",
    declinedBy: ["Josh Bell <josh.bell@gmail.example>"],
    event: event("book-club", 24 * 20, {
      ...personal,
      title: "Book club",
      attendees: ["Josh Bell <josh.bell@gmail.example>", "Ana Silva <ana.silva@gmail.example>"],
    }),
  },
  {
    kind: "cancelled",
    updated: "u3",
    event: event("dinner", 5, {
      ...personal,
      title: "Dinner at Bar Rosa",
      location: "Bar Rosa, Fortitude Valley",
      organizer: "Mia Chen <mia.chen@gmail.example>",
      attendees: ["Mia Chen <mia.chen@gmail.example>"],
      myResponse: "accepted",
    }),
  },
];
