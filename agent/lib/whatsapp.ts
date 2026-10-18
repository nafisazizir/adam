const HOUR_MS = 60 * 60 * 1000;
// Meta accepts free-form messages only within 24 hours of the user's last message. A turn runs a
// model before it posts, and a reply past the window fails silently, so stop short of it.
const SERVICE_WINDOW_MS = 24 * HOUR_MS - 30 * 60 * 1000;

// Meta's "re-engagement message" error: the 24-hour window closed before the send.
export const OUTSIDE_SERVICE_WINDOW = 131047;

const BUSINESS_SCOPED_USER_ID = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/u;

// A wa_id is the sender's number as bare digits (61412345678); owner handles are E.164 with the
// plus (+61412345678), so this is the one place the two meet.
export function waIdToE164(waId: string): string | null {
  const digits = waId.trim().replace(/^\+/u, "");
  return /^\d{7,15}$/u.test(digits) ? `+${digits}` : null;
}

// The owner may list a number as WhatsApp's logs show it, bare digits included. Anything that is
// not a plain number stays as typed and still compares ignoring spaces and punctuation.
export function normalizeOwnerNumbers(entries: readonly string[]): string[] {
  return entries.map((entry) => waIdToE164(entry) ?? entry);
}

// A user with a WhatsApp username can arrive with only this id and no phone number.
export function isBusinessScopedUserId(id: string): boolean {
  return BUSINESS_SCOPED_USER_ID.test(id.trim());
}

export function withinServiceWindow(lastInboundAt: string | undefined, now: number): boolean {
  if (!lastInboundAt) return false;
  return now - Date.parse(lastInboundAt) < SERVICE_WINDOW_MS;
}
