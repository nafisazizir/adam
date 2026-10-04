# General activity analysis — fallback lens

Use this when the activity doesn't fit a specialist lens: **Hike, Walk, Yoga, Workout (generic), Crossfit, Rowing, EBike, Elliptical, StairStepper**, or anything else Strava might report. You still wear a coach hat — just a generalist one focused on stimulus, recovery cost, and goal alignment.

## Tools to pull

1. `strava_get_activity(id)` — full session.
2. `strava_get_activity_laps(id)` — only if there's an interval structure (rowing intervals, AMRAP rounds, etc.).
3. `strava_get_activity_zones(id)` — useful for any HR-driven session.
4. Recovery context per Pattern 1, if the session was meaningful in load.

## Treat the session by its category

| Category | Treat as |
|---|---|
| **Hike** | Long-duration aerobic, often low HR but high time-on-feet. Volume contributor, low intensity. |
| **Walk** | NEAT / recovery. Don't analyze for training stimulus unless it was a structured rucking session. |
| **Yoga / mobility** | Recovery and movement-quality work. Don't grade on HR. Note frequency consistency. |
| **Crossfit / functional workout** | Mixed-modal. Look at HR ceiling, time near max, and total duration. Grade on engagement, not structure. |
| **Rowing (Erg)** | Like a Z2/Z3/threshold ride from a coaching perspective — pace per 500m is the key metric (usually in description). |
| **Elliptical / Stair / Indoor cardio** | Aerobic conditioning. HR-driven analysis. Treat like an indoor "cross-training" session. |

## Metrics that matter

- **Duration and HR average** — almost always available.
- **Time in zone** — useful for the moderate-intensity sessions (crossfit, rowing, intervals).
- **Total distance** when distance is meaningful (hike, walk, row, elliptical).

## What you're trying to answer

Three default questions for any non-specialist activity:

1. **Was this a stress (training stimulus) or a recovery (active rest) session?** Time-in-zone tells you. Z3+ time of any meaningful duration = stress. Mostly Z1/Z2 + < 60 min = recovery.
2. **Does it fit the week's plan?** A user piling on a 4-hour hike after three hard run days is adding load they may not have budgeted for. Note it.
3. **Is the frequency right?** Yoga/mobility especially: presence matters more than performance. If they've done 0 mobility sessions in two weeks during a heavy training block, that's a flag.

## Worked-example output template (hike)

```
**Verdict:** 3h hike — meaningful aerobic time-on-feet, low intensity. Net additive to weekly volume without burning much recovery.

**Key observations**
- 3:04:11 / 12.8 km / 620 m elevation gain.
- HR avg 118 (low Z2 for you), max 142.
- Time in zone: Z1 64%, Z2 33%, Z3 3%.

**Reasoning**
This is a clean aerobic / NEAT contribution day — long, low, with some climbing. Not a training stress in the same sense as a Z2 run, but counts toward your weekly aerobic time. Body battery dropped from 78 → 41 over the day per Garmin, so it cost something — your evening recovery is what to watch.

**Recommendations**
- If tomorrow has a hard run scheduled, check sleep + HRV in the morning. Hike + run back-to-back is a fatigue accumulator.
- No specific training adjustment needed — this is the kind of session that supports base aerobic fitness without specific adaptation cost.

**Flags**
None.
```

## Common pitfalls

- **Don't impose structure where there isn't any**. A hike isn't an interval workout; don't grade it on "did you hit your pace targets" — there were no pace targets.
- **Don't ignore total-time-on-feet** for long walks/hikes when assessing weekly load. 3 hours is real cost even at low HR.
- **Don't treat yoga/mobility as "doing nothing."** It's load-management. Frame it that way.
- **Description matters more for these.** A "workout" tagged on Strava could be anything from a HIIT class to a kettlebell flow. Read the description before you assume.
