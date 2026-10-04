# Timestamps & time math across modules

The riz-mcp server normalizes every timestamp into one of two shapes. Trust them. Don't re-parse the underlying API timestamps yourself.

## The two shapes

### `Instant` — a specific moment in time

```ts
{
  utc: "2026-05-19T06:32:11Z",          // ISO 8601 UTC, no milliseconds
  local: "2026-05-19T16:32:11+10:00",   // local wall-clock + offset
  display: "Tuesday 19 May 2026, 16:32 AEST",
  tz?: "Australia/Brisbane"             // IANA tz when available
}
```

- **`utc`** — use for *math*: sorting events, computing durations, comparing across modules.
- **`local`** — useful when you need a machine-readable wall-clock (e.g. "what local hour did this happen at?").
- **`display`** — use when talking to the user. Never reformat unless asked.
- **`tz`** — present when the source provided an IANA name (Strava + Hevy do, Garmin doesn't — Garmin gives a raw offset, so `tz` may be absent on Garmin Instants).

### `CalendarDay` — a calendar date

```ts
{
  date: "2026-05-19",                   // YYYY-MM-DD
  display: "Tuesday 19 May 2026"
}
```

- **`date`** — pass this to Garmin tools that take `date:`.
- **`display`** — show to the user.

## Where Instants vs CalendarDays appear

| Field | Type | Where |
|---|---|---|
| `start`, `end` (Strava activity, Hevy workout) | Instant | Strava activities, laps, splits; Hevy workouts |
| `sleepStart`, `sleepEnd` | Instant | Garmin sleep, Garmin HRV |
| `at` (in body battery / stress timelines, body battery events) | Instant | Garmin body_battery events / readings, stress timeline |
| `calendarDate` | CalendarDay | Every Garmin tool's top-level date |
| `date` | CalendarDay | Hevy body_measurements (after transform) |
| `created`, `updated` | Instant | Hevy workouts, routines, body measurements |

## Cross-module time math — the canonical recipes

### "Did last night's sleep / HRV explain this workout?"

For an activity (Strava or Hevy) with `start` = some Instant:

1. Take `activity.start.local` → extract the date portion (the first 10 chars, `YYYY-MM-DD`).
2. Call `garmin_get_sleep(date=YYYY-MM-DD)` and `garmin_get_hrv(date=YYYY-MM-DD)`.

Why this works: Garmin labels a sleep session by the calendar date it *ended on*. The session that preceded a morning workout on `2026-05-19` is stored under `2026-05-19`, not `2026-05-18`.

For an evening workout, the *same call* still gives you "last night" — i.e. the sleep ending the morning of the workout day. That's almost always what you want; a 23:00 workout's actual immediate recovery context is the morning *of* the workout day, not the one about to start.

Sanity-check by reading `sleepStart` / `sleepEnd` on the result. They're Instants, so you can directly compare to the activity's `start`.

### "What was my body battery / stress state during the workout?"

1. Take `activity.start.local` → extract date.
2. `garmin_get_body_battery(date=YYYY-MM-DD)`, `garmin_get_stress(date=YYYY-MM-DD)`.
3. To find the *level at session start*, scan `body_battery.events[]` for the most recent event before `activity.start.utc`. Or interpolate from `startOfDayLevel` if no event is closer.

### "Accumulated 7-day load before this session"

1. `before_utc = activity.start.utc`.
2. `after_utc = (parseUTC(before_utc) - 7 days)` as ISO.
3. `strava_list_activities(after=after_utc, before=before_utc, per_page=50)`.
4. `hevy_list_workouts(pageSize=10, page=1)` — paginate until `start.utc < after_utc`.

Then sum/aggregate. Don't forget the *current* activity is excluded by the `before` filter.

### "Weekly window"

For "this week" interpreted naturally:

1. Use the user's timezone (the one in Strava activity tz fields or `HEVY_TIMEZONE`). Don't assume server UTC.
2. Compute the start of the local week (Monday 00:00 local or Sunday, per user preference — default Monday).
3. Convert to UTC and pass as `after`.
4. End boundary: `before` = `now`, or pass yesterday's end-of-day if the user said "the past 7 days."

Where the user says "last 7 days" without qualification, prefer a **rolling 7-day window ending now** rather than a calendar week.

## Default-date pitfalls (Garmin)

| Tool | Default if `date` omitted |
|---|---|
| `garmin_get_sleep` | yesterday |
| `garmin_get_hrv` | yesterday |
| `garmin_get_body_battery` | today |
| `garmin_get_stress` | today |
| `garmin_get_steps` | today |

When correlating with a specific activity, **always pass an explicit `date`** so you don't accidentally pull "today's body battery" while reasoning about a workout from three days ago.

## Timezone awareness per module

- **Strava**: tz embedded per activity (`timezone` field like `"(GMT+10:00) Australia/Brisbane"`). The transform extracts the IANA name and applies it. Each activity's Instants are correct for *where the activity happened*, not the user's home tz.
- **Garmin**: provides paired GMT/local timestamps. The transform derives the offset from the pair. Instants have offset but usually no IANA `tz` field.
- **Hevy**: server-configured timezone (`HEVY_TIMEZONE` env, e.g. `Australia/Brisbane`). Every Hevy Instant uses that single tz, *regardless of where the workout actually happened*. If the user trains while traveling, the `local` field may show home-tz wall-clock for a session done abroad. The `utc` is still correct; flag this only if it matters to the analysis.

Trust the `Instant` — these mechanics are abstracted away by the time you see it.
