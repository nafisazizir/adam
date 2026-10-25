import type { CalendarEvent, Email, EmailSummary, EventTime } from "#lib/google.js";
import { formatCalendarDate, formatUserDateTime } from "#lib/time.js";
import { untrusted } from "#lib/untrusted.js";

function when(date: Date | null): string | null {
  return date ? formatUserDateTime(date) : null;
}

function eventTime(time: EventTime): string {
  return time.allDay ? formatCalendarDate(time.date) : formatUserDateTime(time.at);
}

export function describeSpan(start: EventTime, end: EventTime): string {
  if (start.allDay && end.allDay && start.date === end.date) return `${eventTime(start)}, all day`;
  return `${eventTime(start)} to ${eventTime(end)}`;
}

function line(label: string, value: string): string | null {
  return value ? `${label}: ${value}` : null;
}

function emailAttributes(email: EmailSummary): Record<string, string> {
  return { account: email.account, id: email.id };
}

export function describeEmailSummary(email: EmailSummary, enclosing: readonly string[] = []) {
  return {
    account: email.account,
    id: email.id,
    threadId: email.threadId,
    date: when(email.date),
    unread: email.unread,
    important: email.important,
    content: untrusted("email_content", emailAttributes(email), [
      line("From", email.from),
      line("To", email.to),
      line("Subject", email.subject),
      line("Snippet", email.snippet),
    ], enclosing),
  };
}

export function describeEmail(email: Email) {
  return {
    account: email.account,
    id: email.id,
    threadId: email.threadId,
    date: when(email.date),
    unread: email.unread,
    truncated: email.truncated,
    attachments: email.attachments.map((attachment) =>
      untrusted("email_content", emailAttributes(email), [
        `${attachment.filename} (${attachment.mimeType}, ${attachment.size} bytes)`,
      ]),
    ),
    content: untrusted("email_content", emailAttributes(email), [
      line("From", email.from),
      line("To", email.to),
      line("Cc", email.cc),
      line("Subject", email.subject),
      "",
      email.body || "(no text body)",
    ]),
  };
}

export function describeEvent(event: CalendarEvent) {
  return {
    account: event.account,
    calendarId: event.calendarId,
    id: event.id,
    allDay: event.start.allDay,
    start: eventTime(event.start),
    end: event.end.allDay ? `${eventTime(event.end)} (last day, inclusive)` : eventTime(event.end),
    myResponse: event.myResponse,
    link: event.link,
    meetLink: event.meetLink,
    content: untrusted("calendar_content", { account: event.account, id: event.id }, [
      line("Calendar", event.calendar),
      line("Title", event.title || "(untitled)"),
      line("Location", event.location),
      line("Organizer", event.organizer),
      line("Attendees", event.attendees.join(", ")),
      line("Description", event.description),
    ]),
  };
}
