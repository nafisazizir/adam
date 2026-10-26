import { briefingGuidance, briefingMessage, type BriefingSection } from "#lib/briefing.js";
import type { CalendarEvent } from "#lib/google.js";
import { renderGoogleBriefing, type GoogleBriefing } from "#lib/google-briefing.js";
import { currentTimeContext } from "#lib/time.js";
import { newsletters, timeSensitive } from "#evals/inbox/new-mail.js";

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000);

function meeting(id: string, account: string, title: string, startsIn: number, hours: number): CalendarEvent {
  return {
    account,
    calendar: account,
    calendarId: "primary",
    id,
    title,
    start: { allDay: false, at: hoursFromNow(startsIn) },
    end: { allDay: false, at: hoursFromNow(startsIn + hours) },
    location: "",
    description: "",
    organizer: "",
    attendees: [],
    myResponse: "accepted",
    link: null,
    meetLink: null,
  };
}

export const ordinaryDay: CalendarEvent[] = [
  meeting("standup", "work", "Team standup", 1, 0.25),
  meeting("focus", "work", "Focus time", 2, 2),
  meeting("one-on-one", "work", "Weekly 1:1 with Priya", 5, 0.5),
];

const quietMail = newsletters.filter((email) => email.category === "primary");

export const quietDay: GoogleBriefing = {
  events: ordinaryDay,
  moreEvents: false,
  mail: quietMail,
  moreMail: false,
  needsConnecting: [],
};

export const needsThem: GoogleBriefing = {
  events: ordinaryDay,
  moreEvents: false,
  mail: timeSensitive,
  moreMail: false,
  needsConnecting: ["uni"],
};

// The real guidance and renderer over fixed Google data, so the eval reads no real account.
export function googleBriefingMessage(google: GoogleBriefing): Promise<string> {
  const section: BriefingSection = { name: "google", render: () => renderGoogleBriefing(google) };
  const now = new Date();
  return briefingMessage(currentTimeContext(now), { owner: { issuer: "eval", principalId: "eval" }, now }, [
    briefingGuidance,
    section,
  ]);
}
