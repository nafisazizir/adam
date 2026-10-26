import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export interface ChannelSubject {
  readonly account: string;
  readonly calendarId: string;
}

export interface CalendarNotification extends ChannelSubject {
  readonly channelId: string;
  readonly state: string;
}

// A Calendar push is a bare POST with no body and no Google signature; the one proof it is ours is
// the channel token Adam set when it opened the channel, which Google echoes on every notification.
// The token names the account and calendar and is an HMAC bound to the channel id, under a key
// derived from a server secret, so no new secret is needed and a token copied to another channel
// fails.
export function calendarChannelTokens(secret: string) {
  const key = Buffer.from(hkdfSync("sha256", secret, "adam-calendar-channel", "token", 32));
  const signature = (channelId: string, subject: ChannelSubject) =>
    createHmac("sha256", key)
      .update(JSON.stringify([channelId, subject.account, subject.calendarId]))
      .digest("base64url");

  return {
    sign(channelId: string, subject: ChannelSubject): string {
      return new URLSearchParams({
        account: subject.account,
        calendar: subject.calendarId,
        sig: signature(channelId, subject),
      }).toString();
    },

    verify(channelId: string, token: string): ChannelSubject | null {
      const params = new URLSearchParams(token);
      const account = params.get("account");
      const calendarId = params.get("calendar");
      const given = Buffer.from(params.get("sig") ?? "", "utf8");
      if (!account || !calendarId || !given.length) return null;
      const expected = Buffer.from(signature(channelId, { account, calendarId }), "utf8");
      return given.length === expected.length && timingSafeEqual(given, expected) ? { account, calendarId } : null;
    },
  };
}

export type CalendarChannelTokens = ReturnType<typeof calendarChannelTokens>;

// Null for anything Adam did not open a channel for.
export function parseCalendarNotification(headers: Headers, tokens: CalendarChannelTokens): CalendarNotification | null {
  const channelId = headers.get("x-goog-channel-id");
  const token = headers.get("x-goog-channel-token");
  const state = headers.get("x-goog-resource-state");
  if (!channelId || !token || !state) return null;
  const subject = tokens.verify(channelId, token);
  return subject ? { ...subject, channelId, state } : null;
}
