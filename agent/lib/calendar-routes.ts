import type { SessionAuthContext } from "eve/context";

import {
  CalendarTooLargeError,
  calendarAuth,
  calendarChangeMessage,
  calendarRunSchema,
  coalescedCalendarRun,
  processCalendar,
  staleChannelKey,
  staleChannelTtlSeconds,
  takeDailyCalendarRun,
  type CalendarReader,
} from "#lib/calendar-changes.js";
import { parseCalendarNotification, type CalendarChannelTokens } from "#lib/calendar-push.js";
import { GoogleApiError, GoogleNeedsConnectingError, type GoogleOwner } from "#lib/google.js";
import { parseJson } from "#lib/qstash.js";
import type { SharedCache } from "#lib/shared-cache.js";

const queuedMarkerSlackSeconds = 60;

export interface CalendarPushDeps {
  readonly tokens: CalendarChannelTokens;
  readonly cache: SharedCache;
  readonly today: () => string;
  readonly now?: () => Date;
  publish(run: ReturnType<typeof coalescedCalendarRun>): Promise<void>;
}

// Google retries only a 5xx, so anything Adam will never act on is answered 2xx.
export function calendarPushHandler(deps: CalendarPushDeps) {
  return async (request: Request): Promise<Response> => {
    const notification = parseCalendarNotification(request.headers, deps.tokens, deps.now?.() ?? new Date());
    if (!notification) {
      console.warn("[calendar] rejected a push without a channel token Adam signed");
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    // `sync` opens every channel and changes nothing.
    if (notification.state !== "exists") return Response.json({ ok: true, ignored: notification.state });
    if (await deps.cache.get(staleChannelKey(notification.channelId))) {
      return Response.json({ ok: true, ignored: "stale_channel" });
    }

    const run = coalescedCalendarRun(
      { account: notification.account, calendarId: notification.calendarId, channelId: notification.channelId },
      deps.now?.(),
    );
    const queuedKey = `calendar-queued:${run.deduplicationId}`;
    if (await deps.cache.get(queuedKey)) return Response.json({ ok: true, coalesced: true });
    if (!(await takeDailyCalendarRun(deps.cache, run.body, deps.today()))) {
      return Response.json({ ok: true, ignored: "daily_cap" });
    }

    try {
      await deps.publish(run);
    } catch (error) {
      console.error("[calendar] failed to queue a calendar run", error);
      return Response.json({ ok: false, error: "publish_failed" }, { status: 500 });
    }
    await deps.cache.set(queuedKey, true, run.delaySeconds + queuedMarkerSlackSeconds);
    return Response.json({ ok: true });
  };
}

// A QStash retry costs a message; only a failure that may pass is worth one.
function isPermanent(error: unknown): boolean {
  if (error instanceof CalendarTooLargeError) return true;
  return error instanceof GoogleApiError && error.status >= 400 && error.status < 500 && error.status !== 429;
}

export interface CalendarHome {
  readonly owner: GoogleOwner;
  deliver(message: string, auth: SessionAuthContext): Promise<void>;
}

export interface CalendarRunRouteDeps {
  readonly cache: SharedCache;
  readonly timeContext: () => string;
  readonly now?: () => number;
  verify(request: Request, body: string): Promise<boolean>;
  isListed(owner: GoogleOwner, account: string): Promise<boolean>;
  ownerAddresses(owner: GoogleOwner): Promise<readonly string[]>;
  reader(owner: GoogleOwner, account: string, calendarId: string): CalendarReader;
}

export function calendarRunHandler(deps: CalendarRunRouteDeps) {
  return async (request: Request, home: () => Promise<CalendarHome | null>): Promise<Response> => {
    const body = await request.text();
    if (!(await deps.verify(request, body))) {
      return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
    }

    const parsed = calendarRunSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      console.warn("[calendar] rejected malformed calendar run");
      return Response.json({ ok: false, error: "invalid_payload" }, { status: 400 });
    }
    const run = parsed.data;

    const target = await home();
    if (!target) {
      console.warn("[calendar] skipping a calendar change; no home delivery target is stored");
      return Response.json({ ok: true, ignored: "no_home_target" });
    }
    const { owner } = target;

    try {
      // A channel that outlived its account (a stop that failed) is ignored until it expires.
      if (!(await deps.isListed(owner, run.account))) {
        await deps.cache.set(staleChannelKey(run.channelId), true, staleChannelTtlSeconds);
        console.warn("[calendar] skipping a calendar change; its account is no longer connected");
        return Response.json({ ok: true, ignored: "unlisted" });
      }

      const outcome = await processCalendar(run, {
        cache: deps.cache,
        reader: deps.reader(owner, run.account, run.calendarId),
        ...(deps.now ? { now: deps.now } : {}),
        ownerAddresses: () => deps.ownerAddresses(owner),
        deliver: (changes) =>
          target.deliver(calendarChangeMessage(run.account, changes, deps.timeContext()), calendarAuth(owner, run.account)),
      });
      console.log(`[calendar] ${run.account}: ${JSON.stringify(outcome)}`);
      return Response.json({ ok: true, ...outcome });
    } catch (error) {
      if (error instanceof GoogleNeedsConnectingError) {
        console.warn(`[calendar] skipping a change on ${run.account}; it needs connecting`);
        return Response.json({ ok: true, ignored: "needs_connecting" });
      }
      if (isPermanent(error)) {
        console.error(`[calendar] giving up on a change on ${run.account}; retrying cannot help`, error);
        return Response.json({ ok: true, ignored: "permanent_failure" });
      }
      console.error(`[calendar] failed to process a change on ${run.account}`, error);
      return Response.json({ ok: false, error: "processing_failed" }, { status: 500 });
    }
  };
}
