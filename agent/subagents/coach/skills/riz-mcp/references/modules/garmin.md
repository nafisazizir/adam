# Garmin module

Garmin is the source of truth for **recovery and wellness** — sleep, HRV, body battery, stress, steps. All five tools are daily-grain (one call → one day of data). This is the module that turns "what did you do" into "what could you handle today and what should you do tomorrow."

## Tools

### `garmin_get_sleep`
Sleep data for one night.

Params:
- `date` — `YYYY-MM-DD`. Defaults to **yesterday**. Garmin labels a sleep session by the calendar date it ended on, so for a workout on date `D` the preceding sleep is `date=D`.

Output:
- `calendarDate` — CalendarDay.
- `sleepStart`, `sleepEnd` — Instants. Use these to verify which night you actually pulled.
- `totalSleepSeconds`, `napSeconds`, `awakeCount`.
- `stages` — `{ deepSeconds, lightSeconds, remSeconds, awakeSeconds, unmeasurableSeconds }`.
- `sleepScore`, `sleepScoreQualifier`, `sleepScoreFeedback`, `sleepScoreInsight` — Garmin's narrative + score.
- `averageRespiration`, `avgSleepStress`.
- `restingHeartRate` — overnight RHR. *This* is the canonical RHR, not "current HR right now."
- `avgOvernightHrv`, `hrvStatus` — overnight HRV summary. Cross-check with `garmin_get_hrv` if you need the baseline range.
- `bodyBatteryChange` — net body battery delta across the sleep window.

### `garmin_get_hrv`
Overnight HRV summary with baseline range.

Params:
- `date` — `YYYY-MM-DD`. Defaults to **yesterday**.

Output:
- `calendarDate` — CalendarDay.
- `status` — Garmin's HRV status string (e.g. `"BALANCED"`, `"UNBALANCED"`, `"LOW"`, `"POOR"`).
- `lastNightAvg`, `lastNight5MinHigh`, `weeklyAvg`.
- `baseline` — `{ lowUpper, balancedLow, balancedUpper, markerValue }`. The athlete's *personal* HRV range. This is gold for reasoning — "61 ms with a balanced range of 58–82" tells a different story than just "61 ms".
- `feedbackPhrase` — Garmin's qualitative read.
- `sleepStart`, `sleepEnd` — Instants for the measurement window.

### `garmin_get_body_battery`
Body Battery (Garmin's combined recovery score, 0–100) across a day.

Params:
- `date` — `YYYY-MM-DD`. Defaults to **today**.

Output:
- `calendarDate` — CalendarDay.
- `currentLevel`, `startOfDayLevel`, `endOfDayLevel`, `dayHigh`, `dayLow`.
- `readingCount` — how many minute-level samples were observed.
- `events` — array of major charge/drain events. Each: `{ type, start (Instant), durationMinutes, impact, feedback }`. Useful for spotting a training session as a drain or a long nap as a charge.

For pre-workout readiness, `startOfDayLevel` is the most predictive number. For post-workout fatigue, the difference between session start and session end (interpolate from events).

### `garmin_get_stress`
Daily stress aggregates.

Params:
- `date` — `YYYY-MM-DD`. Defaults to **today**.
- `include_timeline` — boolean. Default false. Set true only if you need minute-level data; otherwise the per-bucket totals are enough.

Output:
- `calendarDate` — CalendarDay.
- `avgStressLevel`, `maxStressLevel` — 0–100 scale.
- `durationSeconds` — `{ rest, low, medium, high, activity, uncategorized, total }`.
- `percentages` — `{ rest, low, medium, high }`.
- `timeline` (optional) — `[{ at: Instant, level }]`.

"High stress %" on non-training days is a useful proxy for life load (work, travel, illness coming on). On training days, stress will be dominated by `activity`-classified blocks — read total + non-activity context.

### `garmin_get_steps`
Daily step count.

Params:
- `date` — `YYYY-MM-DD`. Defaults to **today**.
- `days` — integer 1–30. Defaults to 1. If `days > 1`, returns an array of daily entries ending on `date` inclusive.

Output (per day):
- `calendarDate` — CalendarDay.
- `totalSteps`, `totalDistanceMeters`, `stepGoal`.

Mostly useful as a NEAT proxy (non-exercise activity) and as a recovery context signal — a day with 18,000 steps after a hard run is *not* a rest day.

## When to reach for which tool

- **Pre-workout readiness** → start with `garmin_get_body_battery` (startOfDayLevel) and last night's `garmin_get_sleep` + `garmin_get_hrv`.
- **Post-workout context for a morning session** → previous night's `garmin_get_sleep` and `garmin_get_hrv` (pass `date=` the activity's local calendar date).
- **Post-workout context for an evening session** → today's `garmin_get_body_battery` and `garmin_get_stress`, plus last night's sleep/HRV.
- **Detecting accumulated fatigue** → loop 7–14 days of `garmin_get_hrv` and watch the trend vs the `baseline.balancedLow`–`balancedUpper` band.
- **NEAT / lifestyle load** → `garmin_get_steps(days=7)`.

## Gotchas

- **Default-date asymmetry**: sleep/HRV default to *yesterday*; body battery / stress / steps default to *today*. Always pass an explicit date when correlating with a specific activity.
- **Sleep is labeled by end date**: the night before a workout on `D` is `date=D` (not `D-1`). Confirm with `sleepStart` / `sleepEnd` if anything looks off.
- **Empty data is normal**: if the user took the watch off, fields will be missing. Don't fabricate; note the gap.
- **HRV `weeklyAvg` is rolling**, not calendar-week. It's the rolling average ending on the queried date.
- **Multiple wellness endpoints share `dailyStress`**: `body_battery` and `stress` both hit the same underlying endpoint plus extras. Cost-wise they're cheap to call; no need to batch manually.
- **Body Battery `events` is best-effort**: it can be empty even on a day with reading data. Reason from `startOfDayLevel` / `endOfDayLevel` / `dayHigh` / `dayLow` if events are missing.
- **Auth is username/password** under the hood, so a 401/403 will auto-reauth — if you see one mid-conversation, retry once; if it persists, surface the auth issue to the user.
