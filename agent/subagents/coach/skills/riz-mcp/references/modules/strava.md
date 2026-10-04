# Strava module

Strava is the source of truth for **endurance activity**: runs, rides, swims, hikes, walks, and *recorded* weight-training sessions (those are usually richer in Hevy — see "WeightTraining gotcha" below).

## Tools

### `strava_list_activities`
List recent activities, newest first. The main entry point when the user references a recent session without naming it.

Params:
- `after` — ISO date string. Only activities after this date. Server converts to seconds-since-epoch internally; pass an ISO string.
- `before` — ISO date string. Symmetric to `after`.
- `page` — integer (default 1).
- `per_page` — integer (default 30, max 200).

Output: array of activity summaries. Each activity has:
- `id`, `name`, `sport_type` (e.g. `"Run"`, `"Ride"`, `"Swim"`, `"WeightTraining"`, `"Hike"`, `"Walk"`)
- `start` — Instant (the original `start_date` / `start_date_local` / `timezone` fields are stripped and replaced with this)
- `distance`, `moving_time`, `elapsed_time`, `total_elevation_gain`
- `average_speed`, `max_speed`, `average_heartrate`, `max_heartrate`
- `average_watts`, `weighted_average_watts` (rides with power), `kilojoules`, `device_watts`
- `suffer_score`, `kudos_count`, etc.
- For `WeightTraining`: `description` is auto-merged from the detail endpoint (often contains Hevy-exported sets).

### `strava_get_activity`
Full detail for one activity. Use when the list summary isn't enough — splits, segment efforts, calories, gear, full description.

Params:
- `id` — integer activity id (required).
- `include_all_efforts` — boolean (default false). Set true if you need segment efforts (e.g. for a route progression check).

Output: same fields as the list summary plus:
- `splits_metric`, `splits_standard` — per-km / per-mile splits, each transformed with a `start` Instant.
- `laps` — auto-detected laps (not the same as the user-marked laps; use `strava_get_activity_laps` for those).
- `segment_efforts`, `best_efforts` — present when `include_all_efforts` is true.
- `calories`, `description`, `gear_id`, `device_name`.

### `strava_get_activity_laps`
The user-marked laps from the watch. The single most useful tool for **interval analysis** (e.g. a Z5 track session: pulled lap-by-lap to see per-rep pace and HR).

Params:
- `id` — integer activity id.

Output: array of laps. Each lap has `start` (Instant), `lap_index`, `distance`, `elapsed_time`, `moving_time`, `average_speed`, `average_heartrate`, `max_heartrate`, `average_cadence`, `average_watts` (where applicable), `total_elevation_gain`.

### `strava_get_activity_zones`
Heart-rate and power zone distribution for a specific activity. Returns time-in-zone, which is the right way to characterize the *intensity profile* of an endurance session.

Params:
- `id` — integer activity id.

Output: array of zone objects (one for HR, optionally one for power). Each has `distribution_buckets` with `min`, `max`, `time` (seconds). Empty array if zones aren't configured on the account.

### `strava_get_autehnticated_athlete`
*(yes, this typo is in the real tool name — call it exactly as written)*

Returns the authenticated athlete profile: `id`, `firstname`, `lastname`, `weight`, `ftp`, `measurement_preference`, etc. Use this primarily to **get the athlete `id`** for `strava_get_athlete_stats`.

### `strava_get_athlete_zones`
The athlete's configured heart-rate and power zones (the personal definition of Z1–Z5). This is the basis for any "what zone was that?" reasoning. Cache it for the conversation.

Output: `{ heart_rate: { custom_zones, zones: [{ min, max }, ...] }, power: { zones: [...] } }`.

### `strava_get_athlete_stats`
Lifetime / recent rollups (recent run totals, recent ride totals, YTD, all-time, biggest ride, biggest climb). Useful as **trailing-period context** for a weekly review without paginating through every activity.

Params:
- `athlete_id` — integer. Must match the authenticated athlete. Get it from `strava_get_autehnticated_athlete`.

## When to reach for which tool

- "How was today's run?" → `strava_list_activities` (page 1) → `strava_get_activity(id)` → `strava_get_activity_laps(id)` if it had structure → `strava_get_activity_zones(id)` for intensity profile.
- "What's my Z2 cap?" → `strava_get_athlete_zones`.
- "How many km this month / am I on track for the year?" → `strava_get_athlete_stats`.
- "Compare this segment effort to my history" → `strava_get_activity(id, include_all_efforts=true)`.
- "Show me my last 10 runs" → `strava_list_activities(per_page=50)` and filter client-side by `sport_type === "Run"`.

## Gotchas

- **Field renames after transform**: `start_date`, `start_date_local`, `timezone`, `utc_offset` are removed from the raw payload. They're replaced by a single `start` field of type `Instant`. Same applies to laps, segment efforts, best efforts, and splits.
- **WeightTraining gotcha**: Strava's `WeightTraining` activities have their `description` field auto-merged in `strava_list_activities` (the activity detail is fetched eagerly for these). The description often contains Hevy-exported sets/reps in a readable text format. **But the source of truth for strength work is Hevy**. Use Hevy when analyzing lifts; only fall back to the Strava description if Hevy is unavailable or the user explicitly references the Strava activity.
- **Date filters**: `after` / `before` filter by activity start time. Both are inclusive of the boundary day if you pass the date only.
- **Pagination**: `per_page` default is 30. For a 7-day window with multiple sessions per day, 30 is usually enough. For a 90-day progression check, set `per_page=200`.
- **Zones may be empty**: If the athlete hasn't configured zones on Strava, `strava_get_activity_zones` returns `[]`. Note it and reason from HR averages and known thresholds instead of inventing zones.
- **`average_watts` vs `weighted_average_watts`**: prefer `weighted_average_watts` (NP-equivalent) for ride intensity; raw average understates variable rides.
