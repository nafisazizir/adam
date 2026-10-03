# Recipe — Post-workout analysis

A single session gets the full coach treatment: session + recovery context + load context + history + structured verdict.

Use this recipe whenever the user asks about **one specific session** — "how did my run go", "analyze today's lift", "why did this feel hard", "review my workout". Also the recipe a future webhook will invoke when a new workout is saved.

If the user is asking about *the week* rather than a single session, use the `weekly-review` recipe instead. If they want trend on one specific exercise or route, use `progression-check`.

## Inputs

- **Target session** — either an explicit identifier (Strava activity `id`, or Hevy `workoutId`), or *the most recent* if unspecified.
- **(Optional) framing** — the user might describe how it felt ("brutal", "easy day"); capture this as a hypothesis to test against the data, not as ground truth.

## Workflow

### 1. Resolve the target activity

If the user named a specific activity → use the given id directly.

If unspecified:
- Default to the most recent: `strava_list_activities(per_page=1)` *and* `hevy_list_workouts(pageSize=1)`. Pick whichever has the more recent `start.utc`.
- If the user said "today's lift" / "my workout" / something strength-flavored, prefer Hevy.
- If the user said "my run / ride / swim", prefer Strava.

State the resolved activity to the user before you start ("Analyzing your 5:32 AM run from this morning…") so they can correct.

### 2. Classify and load the specialist lens

Read `sport_type` (Strava) or infer from Hevy structure. Then read the matching specialist file:

| Activity | Reference to read |
|---|---|
| Run / TrailRun / VirtualRun | `../activity-analysis/run.md` |
| Ride / VirtualRide / MountainBikeRide / GravelRide | `../activity-analysis/ride.md` |
| Swim | `../activity-analysis/swim.md` |
| Hevy workout *or* Strava WeightTraining | `../activity-analysis/strength.md` |
| Hike, Walk, Yoga, anything else | `../activity-analysis/general.md` |

The specialist file tells you which metrics matter and what good/bad looks like.

### 3. Pull session detail

- **Strava activity**: `strava_get_activity(id)`. Add `strava_get_activity_laps(id)` if the session had structure (intervals, prescribed laps). Add `strava_get_activity_zones(id)` for any HR-driven session.
- **Hevy workout**: `hevy_get_workout(workoutId)` (you may already have it from `hevy_list_workouts`, but fetch detail if anything is missing).
- For HR/zone reasoning: `strava_get_athlete_zones` *once* (cache for the rest of the analysis).

### 4. Pull recovery context (Pattern 1 from `../combining-data.md`)

Extract the activity's local calendar date `D` from `activity.start.local` (first 10 chars).

- `garmin_get_sleep(date=D)` — the sleep that *preceded* the workout.
- `garmin_get_hrv(date=D)` — overnight HRV with personal baseline range.
- `garmin_get_body_battery(date=D)` — same-day battery profile.
- `garmin_get_stress(date=D)` — same-day stress totals (no need for timeline).

If the workout was late in the evening, body battery / stress data is most useful *pre-workout* (look at events before `activity.start.utc`).

### 5. Pull accumulated load (Pattern 2)

Window: 7 days ending at `activity.start.utc`.

- `strava_list_activities(after=<7d before activity>, before=<activity start>, per_page=50)` — sum moving time, count sessions, identify any high-intensity sessions.
- `hevy_list_workouts(pageSize=10)` — paginate until `start.utc < (activity.start - 7d)`. Sum sets-per-muscle-group if the current session is strength.

You don't need to deep-analyze every prior session — just the load shape (how much, how hard, how recent).

### 6. (Strength only) Pull exercise history for key lifts

For each main lift in the session (the compounds and headline exercises — typically top 3–5):

1. From the workout's `exercises[].exercise_template_id`, you already have the template id; no need for an extra lookup.
2. `hevy_get_exercise_history(exerciseTemplateId, start_date=<8 weeks ago>)`.
3. Pull last 3–5 sessions of that lift; compute working-weight trend and estimated 1RM (Epley) trend.

### 7. Apply the playbook + cross-module patterns

Apply the metrics from the specialist reference (step 2's file), then layer the cross-module reasoning from `../combining-data.md`:

- Pattern 1 (Recovery × performance) — the default lens for "why did this session look the way it did."
- Pattern 2 (Accumulated fatigue) — apply when single-session recovery doesn't explain things and 7-day load is high.
- Pattern 5 (Stress × training quality) — apply when recovery numbers look fine but performance was off.
- Pattern 3 (Plan adherence) — apply for strength sessions where the user follows a Hevy routine.

### 8. Produce the coach-grade output

Use the output structure defined in the core SKILL.md and the worked-example template from the specialist reference.

```
**Verdict:** <one line>

**Key observations**
- 3–5 bullets, numbers + interpretation

**Reasoning**
<narrative tying session metrics to recovery / load / history>

**Recommendations**
- Concrete next steps. Today / next session / next week.

**Flags / concerns**
- Only if real. Otherwise: "None."
```

### Output schema for webhook-friendliness

Keep section headings exactly as shown (`**Verdict:**`, `**Key observations**`, `**Reasoning**`, `**Recommendations**`, `**Flags / concerns**`). A future webhook handler will rely on this consistent structure to store/render the analysis.

## Quick decision rules

- **If recovery looks bad and performance looks bad** → recovery story (Pattern 1). Don't reach further.
- **If recovery looks fine and performance looks bad** → check accumulated load (Pattern 2) and non-training stress (Pattern 5).
- **If recovery looks bad and performance looks fine** → praise the athlete; they grinded through a hard day. No alarm.
- **If recovery looks fine and performance looks fine** → don't manufacture concerns. Compliment the work and recommend forward.

## Don'ts

- Don't pull every Garmin tool if the workout was unremarkable and the user just wants a quick "how did it go." Use judgment.
- Don't ask the user for context (zones, baselines, how they felt) before doing the analysis — pull what you can first, then ask only if a gap remains.
- Don't generate generic recovery advice ("get more sleep!") when the data doesn't show a sleep deficit. Coach what's there.
- Don't bury the verdict. The one-line summary at the top is the most important sentence in the whole output.
