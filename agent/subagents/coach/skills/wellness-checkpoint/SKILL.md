---
description: Periodic health and wellness checkpoint. Use when a request asks for a checkpoint, a fortnightly or monthly review against the user's goals, or whether their goal or plan should shift.
---

# Wellness checkpoint

A checkpoint looks back over a window (two weeks unless the request says otherwise), measures it against the user's goals and current plan, and proposes what should change. Adam texts the user the findings and proposals; nothing changes until the user agrees in chat.

## 1. Gather

- Goals and limits: the owner's persistent memories (goals, injuries, health limits, preferences), plus any goal the request names. If the request carries notes from the last checkpoint, they are the baseline: what was proposed, what the user agreed to.
- The plan: call `training_data_sources`, then fetch the current block's page from the training plan data source. Read its goal, focus, target volume and key sessions.
- The data: follow the riz-mcp skill's weekly-review recipe over the whole window instead of seven days. Pull training load and volume, quality sessions, recovery (sleep, HRV, resting heart rate, body battery, stress) and body composition. Compare against the window before it when the numbers allow.

Never invent a number. If a source is missing or a goal is not on record, say so in the output.

## 2. Judge

- Progress toward each goal, with the numbers that show it. On track, ahead or behind, and by how much.
- What worked and what did not, judged by what the block needs, not literal adherence.
- Recovery: is the load sustainable, or is something accumulating?
- Whether the goal itself still fits: too easy, out of reach, or overtaken by a new limit (an injury, travel, a change in their memories).

## 3. Propose

At most three changes, each concrete and small enough to act on: move a target date, change a weekly volume, swap or drop a session, shift the goal. Tie each to the evidence. No change is a valid outcome when things are on track; say so rather than inventing tweaks.

Write nothing to Notion and change nothing during a checkpoint. If the request says the user has agreed to specific changes, apply exactly those to the plan page instead, fetch it back to confirm, and report what changed.

## 4. Return

Your final message goes to Adam. Plain text in this shape:

```
window: <local start date> to <local end date>
goal: <each goal and where it comes from (memory, plan page or request), or "none on record">
progress: <per goal, on track / ahead / behind, with the numbers>
working: <the most important thing that is working, concrete>
not working: <the most important thing that is not, concrete, or "nothing notable">
recovery: <one line with the numbers>
proposals:
- <change> | why: <evidence>
checkpoint note: <one line for next time: goal, key numbers, what was proposed>
```

Write `proposals: none` when nothing should change.
