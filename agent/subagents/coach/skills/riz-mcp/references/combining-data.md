# Combining data across modules

The whole point of this MCP is that the *same question* — "was this a good session?" — has a richer answer when you fetch from all three modules at once. This file is the playbook for cross-module reasoning. Each pattern lists when to use it, the tool sequence, and how to read the combined picture.

## Pattern 1 — Recovery × performance

**Use when**: a session felt harder/worse than expected, or you want to explain a metric anomaly (HR drift, slower pace at the same effort, drop in working weight).

**Tool sequence**:
1. Pull the session: Strava (`get_activity` + `get_activity_laps` + `get_activity_zones`) or Hevy (`get_workout`).
2. Pull last night's recovery for the activity's local date:
   - `garmin_get_sleep(date=D)` → `sleepScore`, `totalSleepSeconds`, `stages`, `restingHeartRate`.
   - `garmin_get_hrv(date=D)` → `lastNightAvg` vs `baseline.balancedLow`–`balancedUpper`.
3. Pull same-day state:
   - `garmin_get_body_battery(date=D)` → `startOfDayLevel`.
   - `garmin_get_stress(date=D)` → `avgStressLevel`, `percentages`.

**Reading the picture**:

| Signal | What "bad recovery" looks like |
|---|---|
| HRV | `lastNightAvg` *below* `baseline.balancedLow` or `status` ≠ `BALANCED` |
| RHR | `restingHeartRate` ≥ 5 bpm above the athlete's 7-day average |
| Sleep | `totalSleepSeconds < 6.5h`, or `deepSeconds + remSeconds < 25%` of total |
| Body Battery | `startOfDayLevel < 50` |

When **2 or more** of these line up *and* the session showed degraded markers (HR ≥ +5 bpm at the same pace, working weight down by ≥ 5%, decoupling > 5%, perceived effort high), recovery is a plausible cause. **One** isolated signal is not enough — say so, don't over-attribute.

**Coach output cue**: "HRV last night was 48 (your balanced range is 58–82), RHR was 54 vs your 48 baseline, and body battery started at 38. That's three converging signals — the run's elevated HR isn't a fitness issue, it's a recovery one."

## Pattern 2 — Accumulated fatigue

**Use when**: a single-session view doesn't explain the picture and you suspect cumulative load.

**Tool sequence**:
1. Define a window: usually 7 days, sometimes 14 for slower-burning fatigue.
2. `strava_list_activities(after=<7d ago>, per_page=50)` — sum `moving_time`, count Z3+ time via `strava_get_activity_zones` for each session if intensity matters.
3. `hevy_list_workouts` over the window (paginate until `start.utc < after`). Sum working volume per muscle group from `sets` (filter `type === "normal"`).
4. Loop 7 days of `garmin_get_hrv` — is `lastNightAvg` trending down vs `baseline.balancedLow`?
5. Loop 7 days of `garmin_get_sleep` — average `restingHeartRate` vs the prior 7 days.

**Reading the picture**:
- **Volume up + HRV trend down + RHR drift up** = classic functional overreach. Programmable recovery is needed; consider a deload week.
- **Volume up but HRV/RHR stable** = athlete is absorbing the load. Sustainable, keep going.
- **Volume *down* but HRV trending down anyway** = the cause is non-training (illness, travel, life stress). Check `garmin_get_stress` percentages on the rest days for confirmation.

**Coach output cue**: "Last 7 days = 6 sessions / 8h 20m total + 4 strength sessions. HRV has trended from 72 → 58 over the week, RHR up 4 bpm. You're absorbing more than you're recovering. Recommend an unloading microcycle: cut endurance volume 40%, drop strength to one full-body session."

## Pattern 3 — Plan adherence

**Use when**: the user follows a structured plan and wants to know if executed sessions matched intent.

**Tool sequence**:
1. `hevy_list_routines` (current template the user is following — they'll often name it).
2. `hevy_list_routine_folders` if you need the block context.
3. `hevy_list_workouts` over the same window.
4. For endurance: ask the user what plan they're following (no Strava equivalent of "planned workout"). For each Strava activity, compare to the user-described plan (Z2 long run, intervals, etc.).

**Reading the picture**:
- Match each executed workout to its closest routine. Compare working weights and reps. Flag systematic shortfalls (e.g. squat working weight 5 kg below routine for 3 consecutive sessions).
- Flag missed sessions (planned days with no logged workout). Don't infer "skipped" from a single missed week without checking sleep / stress / steps for an explanation.
- Flag substitutions (different exercise hitting the same muscle) — that's planned flexibility, not a failure.

**Coach output cue**: "Plan called for 4 strength + 4 endurance this week. Executed 3 + 5 — strength was undershot by one session. The skipped day was Tuesday, your HRV was 42 that morning; reasonable choice. Working weights held; one cue: bench top-set has been 82.5 kg for 4 weeks now — time to push or change stimulus."

## Pattern 4 — Body composition × training load

**Use when**: the user is tracking weight/body fat trends and wants to know if training is aligned with body comp goals.

**Tool sequence**:
1. `hevy_list_body_measurements(pageSize=10)` — get the last 4–8 weeks.
2. `strava_get_athlete_stats` for trailing 4-week volume context (you'll need the athlete id from `strava_get_autehnticated_athlete`), or aggregate via `strava_list_activities`.
3. Strength volume from `hevy_list_workouts` over the same window.
4. `garmin_get_steps(days=14)` for NEAT context.

**Reading the picture**:
- **Weight down + strength holding or up + endurance volume up** = recomposition. Good outcome.
- **Weight down + strength dropping** = under-fueling. Recommend nutrition check.
- **Weight up + body fat % up + steps down** = likely off-season / overfeeding; align with stated goal.
- **Weight stable + body fat % down + strength up** = recomposition, no scale signal but real progress. Validate the user isn't disheartened by a flat scale.

**Caveat**: body composition trends are *weekly+*, never *daily*. A single measurement is noise. Always smooth across at least 7–14 days before drawing a conclusion. (Nutrition / scale modules are coming — when they arrive, this pattern gets richer.)

## Pattern 5 — Stress × training quality

**Use when**: HRV looks fine, recovery metrics look fine, but performance still degrades. Or: the user reports feeling worn-down despite no obvious training overload.

**Tool sequence**:
1. `garmin_get_stress(date=...)` for the day of and the few days before the session. Look at `percentages.high` and `avgStressLevel` *excluding training time* (i.e. non-`activity` buckets).
2. `garmin_get_steps(days=7)` — a string of 15k+ step days outside of training is real load.
3. Cross-check with `garmin_get_sleep` — high all-day stress often shows up as elevated `avgSleepStress` overnight.

**Reading the picture**:
- High non-training stress over multiple days with normal HRV at first is a leading indicator — fatigue will manifest a few days later.
- High stress + dropping HRV = sympathetic overload. Recommend down-shifting intensity, even if planned sessions seem manageable.

**Coach output cue**: "Recovery markers look okay on paper, but stress was 60+ avg for 4 of the last 5 days with 22% high-stress time. That's bleeding into your training reserve. Today's session feeling hard is consistent with that — keep the volume but pull intensity to Z2 only this week."

---

## How to layer patterns

Most real questions touch 2+ patterns. Order of operations:

1. **What did the user actually ask?** Start there — don't pull data they didn't ask for unless it's load-bearing.
2. **What's the simplest hypothesis?** Cover that first (Pattern 1 — single-session recovery — is the cheapest).
3. **If the simple answer doesn't fit, widen the lens** — accumulated fatigue (P2), then stress (P5), then plan adherence (P3) for systematic issues, then body comp (P4) for slower trends.
4. **State what you ruled out**, not just what you concluded. "It's not last night's sleep — that was solid; it's the 12-day stretch without a full rest day."

## What *not* to do

- Don't pull every tool every time. Coach efficiency matters; pull what you need.
- Don't invent baselines. If `strava_get_athlete_zones` is empty, say so.
- Don't fight the data. If HRV is fine and the user reports feeling terrible, listen to the user *and* note the divergence — the body's signal beats the device's, and sometimes the watch is just wrong.
- Don't equate "Garmin status = UNBALANCED" with "definitely overtrained." Look at trend + RHR + sleep together. Single tags are headlines; the truth is in the combination.
