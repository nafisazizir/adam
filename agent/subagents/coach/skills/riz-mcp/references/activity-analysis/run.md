# Run analysis — endurance coach lens

When the activity is a **Run** (Strava `sport_type === "Run"` or `"TrailRun"` or `"VirtualRun"`), you wear the **endurance / running coach** hat. You think in zones, decoupling, aerobic durability, pacing strategy. You distinguish *easy*, *threshold*, *VO2*, and *neuromuscular* sessions and evaluate each on its own terms.

## Tools to pull

1. `strava_get_activity(id)` — get the full session.
2. `strava_get_activity_laps(id)` — *especially* if the run had structure (intervals, progression). The laps are where the actual quality lives.
3. `strava_get_activity_zones(id)` — time-in-zone distribution. Tells you what the run *actually* was, not what the user said it was.
4. `strava_get_athlete_zones` — the athlete's personal Z1–Z5 definitions (cache for the session).
5. Recovery context per `references/combining-data.md` Pattern 1.
6. For trend context, `strava_list_activities` filtered to `sport_type === "Run"` over the last 7 days.

## Classify the session first

Before you analyze, figure out what *kind* of run this was:

| Type | Signature |
|---|---|
| **Easy / Z2** | Time-in-zone heavily Z1–Z2 (>80%), HR average mid-Z2 or lower, pace conversational. |
| **Steady / Tempo** | Sustained Z3, fairly flat HR profile, no big surges. |
| **Threshold** | Z4 dominant for a significant block (15+ min sustained or interval format). |
| **VO2 / Intervals** | Z5 segments visible in laps. Look at `strava_get_activity_laps`. |
| **Long run** | Duration > the athlete's normal weekly long run, usually Z2 with a possible Z3 tail. |
| **Race / Time trial** | Z4–Z5 dominant, HR ramps continuously, pace at or near the athlete's best. |

If the user said "easy run" but time-in-zone is 40% Z3, that's a finding — easy days weren't easy. Note it.

## Metrics that matter

### Pace
- **Average pace** and **per-km splits** (from `splits_metric`). Look for drift — a fade in the back third on what was meant to be an even-pace run.
- **GAP (Grade Adjusted Pace)** if elevation is involved — Strava provides this as `gap` on splits and laps.

### Heart rate
- **Average HR** vs the zones from `strava_get_athlete_zones`. Express in zone terms: "avg HR 158 = upper Z2 for you."
- **Aerobic decoupling** for steady-state runs: split the run in half, compare HR/pace ratio for the first vs second half. Decoupling > 5% on an easy run suggests fatigue or under-fueling; < 5% is good aerobic durability. (You'll need `splits_metric` to compute this manually — average HR for first half-distance, divide by avg pace, same for second half, compare.)
- **HR drift on intervals**: per-rep average HR climbing on equal-effort reps = expected; flat or falling = excellent recovery between reps.

### Cadence and form proxies
- **Average cadence** — most runners cruise 168–185 spm. A consistent drop late in the run signals fatigue.
- **Stride length** can be inferred (pace ÷ cadence) but cadence alone is usually enough.

### Time in zone
From `strava_get_activity_zones`:
- "What the run actually was": dominant zone.
- "Was it polarized?": Z1+Z2+Z5 vs Z3. A common training mistake is too much Z3 ("the gray zone") — too hard to be recovery, too easy to drive adaptation.

## What "underperformed and why" reasoning looks like

For an easy run that felt hard:
- HR at the same effort is +5 to +10 bpm vs prior similar runs → **recovery issue**, cross-reference Pattern 1.
- Pace +10s/km at the same HR → could be recovery, fatigue, heat, or under-fueling. Check `garmin_get_sleep` and weather context (if `strava_get_activity` has temperature data).
- Decoupling > 8% on a < 60-min easy run → flag aerobic fatigue or systemic load.

For an interval session that fell apart:
- Rep paces hold for first 60%, fall off → likely a pacing/over-zealous start, not necessarily fitness.
- Reps trend slower from the start → either accumulated fatigue or the prescribed paces were too aggressive given current form.
- HR ceiling earlier than usual (Z5 reached on rep 3 instead of rep 6) → recovery deficit.

## Worked-example output template

```
**Verdict:** Solid Z2 long run, 18 km in 1:42. HR drift confirms strong aerobic durability — not a fitness limiter today.

**Key observations**
- 18.1 km / 1:42:14 / avg 5:38/km, GAP 5:30/km (rolling hills, 220 m gain).
- HR avg 148 (mid-Z2 for you, top of zone is 158); max 162.
- Time-in-zone: Z1 12%, Z2 81%, Z3 7%. Cleanly polarized.
- Decoupling: first half avg HR 145 / pace 5:36; second half 151 / 5:40. ~2% decoupling — well inside aerobic-durable territory.
- Cadence 178 → 176 → 174 across thirds. Mild end-of-run drop.

**Reasoning**
HRV last night was 67 (balanced range 58–82), sleep 7h 40m, body battery started at 78. Recovery was a green light. The slightly elevated late-run HR is expected at this distance for you — you've done five long runs in this 18–22 km band this block and the decoupling has trended down (last three: 3.5% → 2.8% → 2.1%). That's the signal aerobic base is improving.

**Recommendations**
- Hold this long-run distance/intensity next weekend. You're consolidating.
- Mid-week quality session: ready for a threshold block — propose 3×10 min Z4 with 3 min easy. Recovery indicators support adding intensity.
- Cadence drift: keep an eye on it, but it's small. Won't act on it unless it grows.

**Flags**
None today. Continue.
```

## Common pitfalls

- **Don't grade Z2 runs on pace**. Z2 is an HR/effort target, not a pace target. If the run was Z2 by HR but slow, the engine is doing what it should — fitness adaptation will pull the pace down later.
- **Don't conflate "felt hard" with "was hard"**. Cross-check perception against HR + zone distribution. If the user says it was hard but HR was solidly Z2 and decoupling was low, that's a recovery / sleep / fueling story, not a fitness one.
- **Don't praise high average HR**. A high-HR easy run is *worse* than a low-HR one; it means the body was working harder for the same speed.
- **Heat / humidity matters but isn't in the data**. If results look off and the user mentions hot conditions, factor that in qualitatively.
