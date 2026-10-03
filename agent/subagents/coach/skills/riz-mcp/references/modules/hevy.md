# Hevy module

Hevy is the source of truth for **strength training** and **body composition** logging. Workouts (executed), routines (templates), exercises, exercise history (for progression), body measurements.

## Tools

### `hevy_list_workouts`
Recent workouts, newest first.

Params:
- `page` — integer ≥ 1 (default 1).
- `pageSize` — integer 1–10 (default 5, max 10). *Yes, only 10*. Plan multiple pages for week-grain analysis.

Output (per workout):
- `id`, `title`, `description`, `start` (Instant), `end` (Instant), `created` (Instant), `updated` (Instant).
- `exercises[]`:
  - `index`, `title`, `notes`, `exercise_template_id`, `superset_id` (when supersetted).
  - `sets[]`: `index`, `type` (e.g. `"normal"`, `"warmup"`, `"dropset"`, `"failure"`), `weight_kg`, `reps`, `distance_meters`, `duration_seconds`, `rpe`, `custom_metric`.

### `hevy_get_workout`
Full detail for one workout. Use after `hevy_list_workouts` if you need fields that may have been truncated, or after a webhook gives you a fresh `workoutId`.

Params:
- `workoutId` — string id (required).

Output: single workout, same shape as above.

### `hevy_get_workouts_count`
Total lifetime workout count. Useful for context ("this is your 312th logged workout") and pagination math.

Params: none.

Output: `{ workout_count: <number> }`.

### `hevy_get_workout_events`
Newest-first stream of workout *changes* (updated/deleted). Designed for **cache sync**, not for analysis. Only reach for it if the user explicitly wants "what changed since X" — otherwise prefer `hevy_list_workouts`.

Params:
- `page`, `pageSize` — same as list.
- `since` — ISO 8601. Only events after this timestamp.

### `hevy_list_routines`
Routines = workout templates (planned sessions).

Params: `page`, `pageSize` (1–10, default 5).

Output: routines with `exercises[]` and target `sets[]`. The set's `weight_kg` / `reps` represent the *target*, not the executed.

### `hevy_get_routine`
One routine by id.

Params: `routineId` (string).

### `hevy_list_exercise_templates`
The exercise catalog (built-in + custom). Each template has `id`, `title`, `type` (e.g. `"weight_reps"`, `"reps_only"`, `"duration"`, `"weight_distance"`), `primary_muscle_group`, `secondary_muscle_groups[]`, `equipment`, `is_custom`.

Params: `page`, `pageSize` (1–100, default 5). For a one-off lookup ("find me bench press"), set `pageSize=100`.

This is how you map a user's verbal exercise name ("bench", "RDLs") to a template id for `hevy_get_exercise_history`.

### `hevy_get_exercise_template`
One template by id.

Params: `exerciseTemplateId` (string).

### `hevy_list_routine_folders`
Folders grouping routines (e.g. "Strength Phase 1", "Hybrid Block").

Params: `page`, `pageSize` (1–10).

### `hevy_get_routine_folder`
One folder by id.

Params: `folderId` (string).

### `hevy_get_exercise_history`
Every time a specific exercise was performed. **The progression-check workhorse.**

Params:
- `exerciseTemplateId` — string (required). Get from `hevy_list_exercise_templates`.
- `start_date`, `end_date` — optional ISO 8601 filters.

Output: array of entries. Each has the workout context (`workout_id`, `workout_title`, `workout_start` Instant, `workout_end` Instant) plus the `sets[]` performed in that session.

### `hevy_list_body_measurements`
Body composition log (weight, body fat %, circumferences).

Params: `page`, `pageSize` (1–10).

Output: each entry has `date` (CalendarDay), `created` (Instant), `weight_kg`, `fat_percent`, optional girth fields, optional `notes`.

### `hevy_get_body_measurement`
One measurement by date.

Params: `date` — `YYYY-MM-DD` (required).

### `hevy_get_user_info`
Authenticated Hevy user info. Rarely needed for analysis; useful for sanity-checking the account.

Params: none.

## When to reach for which tool

- "Analyze today's lift" → `hevy_list_workouts(pageSize=1)` → `hevy_get_workout(id)` if more detail needed.
- "Is my bench progressing?" → `hevy_list_exercise_templates` to find bench id → `hevy_get_exercise_history(id, start_date=...)`.
- "Am I sticking to the plan?" → `hevy_list_routines` for the current template → diff against executed `hevy_list_workouts` over the same window.
- "Has my weight changed?" → `hevy_list_body_measurements(pageSize=10)` and look at the date trend.
- "How many workouts have I done?" → `hevy_get_workouts_count`.

## Gotchas

- **Field renames after transform**: `start_time` → `start` (Instant), `end_time` → `end`, `created_at` → `created`, `updated_at` → `updated`. The raw `_time` / `_at` fields are removed.
- **`pageSize` cap is 10** for most list endpoints (only `hevy_list_exercise_templates` allows up to 100). A "last 30 days" workout pull will need 3–6 pages depending on training frequency.
- **Set types matter for analysis**: `warmup` and `dropset` sets shouldn't count toward working volume the same way as `normal` sets. Filter on `type === "normal"` when computing working volume / top-set weight; include warmups only when assessing total session time / fatigue.
- **`weight_kg` is always kg**, regardless of the user's display preference. Convert to lb only if the user asks.
- **RPE is optional**: a missing `rpe` doesn't mean the set was easy; the user may just not log it. Treat absence as "unknown effort", not "easy."
- **Hevy timezone is server-configured**, not per-workout. All Hevy Instants come back in the same tz (typically the user's home tz). If the user trains while traveling, the local time may not reflect the wall-clock where they actually were.
- **Routine vs workout volume**: routine sets show *targets* (often weight=0 if it's prescribed by RPE), workout sets show *executed*. Don't sum them together.
- **Strava `WeightTraining` activities are not duplicates**: if the user records the same lift session to both, prefer Hevy for set-level data, Strava for HR / total time.
