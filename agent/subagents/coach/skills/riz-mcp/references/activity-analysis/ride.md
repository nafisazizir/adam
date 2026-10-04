# Ride analysis — cycling coach lens

When the activity is a **Ride** (Strava `sport_type === "Ride"`, `"VirtualRide"`, `"MountainBikeRide"`, `"GravelRide"`, etc.), you wear the **cycling coach** hat. You think in *power* first when it's available, HR second. You evaluate sessions on intensity factor, variability, and what the ride was *supposed to be*.

## Tools to pull

1. `strava_get_activity(id)` — full session, including `average_watts`, `weighted_average_watts`, `kilojoules`, `device_watts`.
2. `strava_get_activity_laps(id)` — essential for interval rides.
3. `strava_get_activity_zones(id)` — both HR and power zone distributions.
4. `strava_get_athlete_zones` — personal power zones (Z1–Z7 typical) and HR zones.
5. Recovery context per `references/combining-data.md` Pattern 1.

If `device_watts` is `false`, the watts in the data are estimated from speed/grade and are *not reliable* — fall back to HR-based analysis and say so.

## Classify the session

| Type | Signature |
|---|---|
| **Recovery** | Z1 dominant, IF < 0.65, smooth power. |
| **Endurance / Z2** | Z2 dominant, IF ~0.65–0.75, VI < 1.05 on flat/steady terrain. |
| **Tempo** | Z3 sustained, IF ~0.75–0.85. |
| **Threshold / sweet spot** | Z4 sustained or interval format, IF ~0.85–0.95. |
| **VO2** | Z5+ intervals, peak power 110–120% FTP. |
| **Group / unstructured** | Highly variable power, VI often > 1.1. Hard to grade as a single intent. |

## Metrics that matter (power-equipped)

### NP / IF / VI
- **Normalized Power (NP)** = `weighted_average_watts` from Strava. Use this as the intensity number, not raw average.
- **Intensity Factor (IF)** = NP ÷ FTP. FTP comes from the athlete profile or `strava_get_athlete_zones` (sometimes encoded as the top of Z4 or as a dedicated `ftp` field on `strava_get_autehnticated_athlete`).
- **Variability Index (VI)** = NP ÷ `average_watts`. Lower = smoother. <1.05 on a steady ride is excellent; >1.15 means the ride was punchy/group-driven.

### Time in zone (power)
- Steady rides should sit in one or two zones cleanly.
- Threshold work should show a clear Z4 block.
- Group rides will look like a chaotic mix — don't grade those as "failed structure"; reframe them as the ride that they were.

### Kilojoules
- A rough proxy for caloric expenditure / glycogen drain. Useful for fueling discussions on rides > 2 hours.

## Metrics that matter (HR-only or estimated-watts)

- Treat `weighted_average_watts` as suggestive, not definitive when `device_watts === false`.
- Lean on `strava_get_activity_zones` HR distribution, lap-by-lap HR, and decoupling (split the ride in half, compare HR/speed ratio).
- For interval sessions without power, look at HR ceiling per rep and the time to ceiling.

## What "underperformed and why" reasoning looks like

For a sweet-spot session that fell off:
- IF dropped between intervals 4–6 → fatigue accumulated; check 7-day load (Pattern 2).
- HR climbed at falling power → classic cardiac drift; if it appeared earlier than usual, check recovery (Pattern 1) and fueling.

For an endurance ride that felt slow:
- VI > 1.1 on what was meant to be steady → terrain or traffic forced surges; not a fitness issue.
- Avg HR up vs prior similar rides at the same NP → recovery deficit.

For a Z2 ride at high HR:
- Often indicates heat, dehydration, or under-fueling on long rides. Note environmental context if available.

## Worked-example output template

```
**Verdict:** Clean 2h Z2 endurance ride with great power discipline. Aerobic base is doing exactly what it should.

**Key observations**
- 2:02:14 / 62.4 km / 248 W avg / 258 W NP / IF 0.72 / VI 1.04.
- HR avg 138 (mid-Z2; ceiling 152, never crossed Z3).
- Time in zone (power): Z1 8%, Z2 79%, Z3 12%, Z4 1%.
- Kilojoules: 1,820.

**Reasoning**
FTP context: NP/FTP = 258/360 = 0.72 IF, comfortably aerobic. Body battery started at 71, HRV was 64 (balanced range 58–82) — fresh enough for this work. VI of 1.04 on rolling terrain is impressive — you stayed disciplined where most riders would surge on the climbs.

Looking back over your last four Z2 rides, NP at the same HR has crept up from 240 → 248 — early signal that aerobic threshold power is improving. Worth confirming with a fresh test in 2–3 weeks.

**Recommendations**
- Next: schedule a 20-min FTP estimate (post-warmup, after a rest day). Numbers say it's time to re-anchor zones.
- Fuel cue: 1,820 kJ in two hours = ~85 g/h carb target on intra-ride. Confirm you hit that — if not, that explains any late-ride mental fade.

**Flags**
None.
```

## Common pitfalls

- **Don't analyze a power file without confirming `device_watts`**. Estimated watts can be off by 30–50%.
- **Don't average across a mixed-effort ride and pretend it's one session**. If laps reveal an interval structure inside a longer ride, analyze the interval block separately.
- **Don't grade group rides on VI**. The structure was the structure; comment on it but don't treat it as failure.
- **Indoor vs outdoor matters**: indoor trainers eliminate environmental variance — HR-power decoupling indoors is purely a fitness/fatigue signal, outdoors it's confounded by wind/temp.
