# Recipe — Weekly review

A multi-day rollup that turns raw activity logs into a coach's read on the training week — what was done, what it cost, and what next week should look like.

Use this recipe whenever the user asks about *the week* rather than a single session — "how was my week", "training week summary", "last 7 days", "weekly volume", "recap my training".

If the user wants one specific session deep-dived, use the `post-workout-analysis` recipe. If they want trend on one specific exercise or route, use `progression-check`.

## Inputs

- **Window** — default: rolling last 7 days ending now (in the user's local timezone). If the user says "this week," prefer Monday-start calendar week unless they specify otherwise. If they give an explicit window, honor it.
- **(Optional) goals** — if the user references a plan or goal in the prompt, anchor the recommendation to that. Otherwise reason from the trends.

## Workflow

### 1. Resolve the window

- Pick `start_local` (Monday of the calendar week, or `now - 7d`) and `end_local` (now or end of the calendar week).
- Convert both to UTC for tool calls (`start_utc`, `end_utc`). See `../timestamps.md` for week-boundary mechanics.

State the window to the user briefly ("Reviewing your week of 13–19 May 2026 (Mon–Sun)…").

### 2. Pull endurance activities (Strava)

- `strava_list_activities(after=start_utc, before=end_utc, per_page=50)`.
- For each session, you have `sport_type`, `start`, `distance`, `moving_time`, `average_heartrate`, `average_watts` / `weighted_average_watts`.
- For intensity profile of the week, optionally pull `strava_get_activity_zones(id)` on the 2–3 sessions that look like quality work (Z3+ avg HR). Skip for easy runs.
- Cache `strava_get_athlete_zones` once for zone interpretation.

### 3. Pull strength workouts (Hevy)

- `hevy_list_workouts(pageSize=10)` — paginate until `start.utc < start_utc`.
- Build a list of session summaries: title, duration, total volume = sum(`weight_kg * reps`) over `type === "normal"` sets.
- Compute **volume per primary muscle group** for the week. Map each exercise via `exercise_template_id` to its `primary_muscle_group` — cache via `hevy_list_exercise_templates(pageSize=100)` once if needed, or just look up the few used templates.

### 4. Pull recovery & wellness trend (Garmin)

Loop the 7 dates of the window. For each `D`:

- `garmin_get_sleep(date=D)` — `totalSleepSeconds`, `sleepScore`, `restingHeartRate`.
- `garmin_get_hrv(date=D)` — `lastNightAvg` and `status` and `baseline`.
- `garmin_get_body_battery(date=D)` — `startOfDayLevel`, `endOfDayLevel`.
- `garmin_get_stress(date=D)` — `avgStressLevel`, `percentages.high`.

Aggregate:
- Avg sleep hours and consistency (stddev across the 7 nights).
- HRV trend (start of week → end of week) and how many nights were below `baseline.balancedLow`.
- Avg RHR across the week and delta from the prior 7 days (optional: pull the prior week if you want a comparison number).
- Body battery: count of days starting < 50 (suggests not fully recovered overnight).
- Stress: count of days with `percentages.high > 15%`.

### 5. Pull body composition (Hevy)

- `hevy_list_body_measurements(pageSize=10)` — get last 4–8 entries.
- Compute weekly delta if at least one measurement falls in the window vs one in the prior week. Don't over-interpret single days.

### 6. (Optional) Plan adherence

If the user has a current routine or routine folder they've referenced:
- `hevy_list_routines` to find the active template.
- Diff the executed workouts (from step 3) against the routine prescriptions. Note matched, modified, and missed sessions.

For endurance, there's no Strava equivalent of a planned workout. If the user described their endurance plan in the prompt, use that as the comparison; otherwise reason from intensity distribution alone.

### 7. Compare against the prior week

A weekly review without trend is just a list. Pull the same window shifted back 7 days for at least:
- Total endurance moving time.
- Total strength sessions and total volume.
- HRV weekly average.

Report the deltas, not just the absolute numbers.

### 8. Produce the coach-grade output

```
**Verdict:** <one line summary of the week — was it productive, fatiguing, balanced, off-track?>

**The week in numbers**
- Endurance: <X sessions / Y hours / split by sport>
- Intensity distribution: <Z1/Z2/Z3+ breakdown if pulled, or qualitative>
- Strength: <N sessions / total volume / top muscle groups hit>
- Sleep: <avg hours / consistency note>
- HRV trend: <start → end, vs baseline>
- Body comp delta: <only if a meaningful measurement was logged>

**Wins**
- 2–4 things that went right. Be specific.

**Concerns**
- 1–3 things to address. Only real ones — don't pad.

**Plan adherence** (only if applicable)
- What the plan called for vs what was executed.

**Next week recommendation**
- Concrete prescription. Either "consolidate at this volume" or "add X / cut Y / deload" with the *why*.
```

## How to read the week

Use the patterns from `../combining-data.md`. The cheat-sheet for a week-grain view:

| Picture | Read |
|---|---|
| Volume up + HRV stable + RHR stable | Healthy progression. Recommend holding or modest add. |
| Volume up + HRV trending down + RHR up | Functional overreach. Recommend deload microcycle. |
| Volume flat + HRV recovering | Coming out of a hard block. Green light for next push. |
| Volume down + HRV down | Non-training stress is the driver. Check stress percentages and steps. |
| Body weight down + strength dropping | Under-fueling. Recommend nutrition check. |
| Body weight stable + body fat down + strength up | Recomposition. Reassure if user is scale-watching. |

## Pitfalls

- **Don't grade a week as bad because volume dropped**. Sometimes that's the correct call (deload, illness, life). Read it in context.
- **Don't compare to "ideal training week" stereotypes**. Compare to *this* athlete's prior weeks.
- **Don't over-interpret HRV drift across only 7 nights**. The trend is suggestive; confirm against RHR and sleep before calling overreach.
- **Don't recommend "more rest" reflexively**. If recovery markers are fine, recommend the work that progresses fitness.
- **Bigger isn't better**. A week with 6 sessions perfectly placed beats one with 8 jammed in.
