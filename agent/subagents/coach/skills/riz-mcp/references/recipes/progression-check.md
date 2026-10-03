# Recipe — Progression check

Take one specific exercise or one specific activity type/route and tell the user whether they're getting better at it, why, and what to do next.

Use this recipe when the user is fixated on **one specific thing** — "is my squat improving", "am I getting faster at the 5k", "track my progression on bench press", "PR check on this segment".

If the user wants overall weekly volume, use the `weekly-review` recipe. If they want to deep-dive one specific session, use `post-workout-analysis`.

## Inputs

- **Target** — required:
  - A specific Hevy exercise (e.g. "back squat"), or
  - A Strava sport type (e.g. "all my 5k runs"), or
  - A Strava segment or named route the user has run/ridden multiple times.
- **Window** — optional. Defaults: 8 weeks for strength, 12 weeks for endurance. The user may override.

If the target is ambiguous (e.g. "back squat" — could be a high-bar or low-bar template), surface the ambiguity briefly and pick the most-used one as a default while saying so.

## Workflow

### Path A — Strength exercise (Hevy)

1. **Resolve the template id**. `hevy_list_exercise_templates(pageSize=100)` if you don't already have it cached. Find the matching `title` (case-insensitive substring match). If multiple match (e.g. "Bench Press (Barbell)" and "Bench Press (Dumbbell)"), pick the one the user has actually used recently — `hevy_get_exercise_history` returns empty for unused templates, so prefer the one with results.

2. **Pull history**. `hevy_get_exercise_history(exerciseTemplateId, start_date=<window start ISO>)`.

3. **Compute per-session metrics**. For each session in the history, filter sets to `type === "normal"` (drop warmups, dropsets, failures), then compute:
   - **Top-set weight** (heaviest `weight_kg`).
   - **Top-set reps** at that weight.
   - **Estimated 1RM (Epley)**: `weight × (1 + reps/30)`. Use the top set; this is reasonable up to ~10 reps.
   - **Total working volume**: `sum(weight_kg × reps)` across normal sets.
   - **Average RPE** across normal sets (where logged).

4. **Plot the trend** mentally / textually. Look at:
   - Estimated 1RM over time — slope.
   - Working weight at the same target rep scheme over time (e.g. if the user does 5×5, track the weight used at 5×5 specifically).
   - Volume trend — sometimes weight is flat but volume is climbing (added sets), which is real progress.
   - RPE trend at the same weight — if RPE drops at the same weight, fitness improved even if the number didn't move.

5. **Classify the trajectory**:
   - **Improving**: e1RM trending up over the window (>2.5% improvement and a generally rising line, not just a one-session PR).
   - **Plateau**: e1RM flat ±2% over the window with sessions at similar RPE.
   - **Regressing**: e1RM trending down, *or* same weight at higher RPE.
   - **Volatile**: large session-to-session swings — usually a deload + restart pattern or inconsistent training.

6. **Reason about why**:
   - For plateau: check accumulated load (Pattern 2 from `../combining-data.md`) — is the user under-recovered and stalling? Check stimulus variety — same scheme for months can stall regardless of recovery.
   - For regression: cross-reference recovery trend (HRV / sleep / RHR) and body comp delta. Under-fueling + high training stress is the classic regressor.
   - For improvement: identify the driver. Was it volume, intensity, frequency, technique?

### Path B — Endurance activity type or route (Strava)

1. **Resolve the target**. Sport type (Run, Ride, Swim) and optionally a distance band (5k = 4.5–5.5 km runs) or a route/segment name.

2. **Pull activities over the window**. `strava_list_activities(after=<window start>, per_page=200)`, then client-side filter by:
   - `sport_type === <type>`.
   - Optionally distance range (for "my 5k runs").
   - Optionally activity name / map for named routes.

3. **For each filtered session, compute**:
   - Pace (per km or per 100m).
   - Average and max HR.
   - Average and weighted power for rides.
   - Time-in-zone if available (`strava_get_activity_zones(id)` — only for the recent few sessions to avoid expensive loops).
   - Best efforts: for runs, look at the activity-level `best_efforts` (1k, 1mi, 5k) which Strava surfaces.

4. **Trend analysis**:
   - **Pace at the same HR**: this is the gold metric. If avg HR was 152 across sessions and pace went 5:25 → 5:15 over the window, real fitness gain.
   - **HR at the same pace**: equivalent — pace held at 5:20 but avg HR went 158 → 150 = aerobic improvement.
   - **Best efforts trend**: a 5k PR is a 5k PR. Worth flagging.
   - For rides: NP at the same HR, or weekly normalized power on a specific route.

5. **Classify the trajectory**: same buckets as strength (improving / plateau / regressing / volatile).

6. **Reason about why**:
   - Improvement on easy runs (lower HR at same pace) usually means aerobic base is rising.
   - Plateau on threshold work often means stimulus is stale — same intensity, same duration, no progression.
   - Regression in pace at the same HR over 4+ weeks is a recovery / fueling story, not a fitness one.

### Common steps (both paths)

7. **Optionally overlay recovery / load** if the trajectory needs explaining:
   - A regression with stable training → suspect non-training factors (sleep, stress, body comp). Pull a 4-week recovery summary.
   - A plateau with rising volume → likely accumulated fatigue. Pattern 2.
   - An improvement with falling volume → either consolidation gains or a methodology change worth identifying.

8. **Recommend the next stimulus**:
   - **Improving + recovered**: keep pushing the dose that's working. Maybe modest progression (small weight bump, or shift one rep scheme).
   - **Improving + accumulating fatigue**: consolidate or unload before pushing more.
   - **Plateau**: change a variable — add a set, change the rep scheme, change the exercise variation, add tempo/pause/cluster work for strength; change interval format for endurance.
   - **Regression**: identify the cause (recovery? fueling? life stress?) and address it before adjusting program.

### 9. Produce the coach-grade output

```
**Verdict:** <one line — improving / plateau / regressing / volatile, with the headline number>

**The numbers**
- <Target identified>
- Window: <X weeks, Y sessions>
- Key trend metric: <e1RM 122 → 138 kg / 5k pace 5:32 → 5:21 / NP 240 → 258 W>
- Secondary metric(s): <volume trend / RPE trend / HR trend>

**Trajectory**
- <Improving | Plateau | Regressing | Volatile>
- <2–3 sentence pattern read>

**Why** (when the trajectory isn't obvious)
- <Driver(s) identified: stimulus, recovery, technique, fueling, frequency>

**Recommendation**
- <Concrete next stimulus adjustment with the reasoning>

**Flags**
- <Only if real>
```

## Pitfalls

- **One PR is not a trend**. Require ≥ 3 sessions before claiming a direction.
- **Compare apples to apples**. Don't compare a 5×5 squat session to a 3×8 squat session and call it progress/regression. Match the rep scheme, or use e1RM, never both unweighted.
- **Match exercise variations exactly**. Different template id = different lift. Front squat at 100 ≠ back squat at 100.
- **Distance bands matter for endurance**. A 3 km tempo run isn't a 5 km PR attempt; don't compare paces across distance bands.
- **Watch the calendar**. A regression that's actually "athlete just finished a hard block" is consolidation, not failure.
- **Best efforts can be noise**. A 5k PR mid-long-run on tired legs is impressive but doesn't mean fresh-legs 5k is faster yet. Note context.
