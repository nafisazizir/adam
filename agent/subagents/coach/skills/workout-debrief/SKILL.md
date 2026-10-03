---
description: Automatic post-workout analysis. Use when a request asks you to analyse a just-finished Strava activity or Hevy workout, save the analysis to the Notion workouts data source, and return a debrief.
---

# Workout debrief

The user just finished a workout and it has been handed to you. Write the full coach analysis, save it to Notion, and return a short debrief. Adam uses the debrief to decide whether to text the user.

The request gives you:
- the workout: source and id
- the training plan data source id
- the workouts data source id
- whether this is a dry run

## 1. Check it hasn't been done already

Query the workouts data source for a page about this same workout: the same date and the same session, matched by title, start time, or a source id in any property. If one exists, don't write another. Your whole final message is then `ALREADY_ANALYSED` followed by the existing page's URL, and you stop.

## 2. Analyse

Follow the riz-mcp skill's post-workout-analysis recipe for this workout.

- Strava activity: call `strava_get_activity`, plus laps and zones as the recipe directs. Classify it by `sport_type` and load the matching specialist lens.
- Hevy workout: call `hevy_get_workout`, then use the strength lens and the exercise history.

Pull recovery and 7-day load as the recipe says. Don't skip steps to save time. This runs with nobody watching, and the bar is a human coach's work.

## 3. Read the plan

Query the plan data source to list its pages, then fetch the current block's page and read its focus, target volume and key sessions.

Treat the plan as a guide, not a contract. Day swaps, split sessions, travel and life are all expected. Don't grade literal adherence; grade whether the work moved the block forward.

Still push. If intensity is consistently undershot, hard sessions are dodged, or volume slides without a real reason, say so plainly. No false praise.

## 4. Write the Notion page

On a dry run, skip this step and write nothing to Notion. Steps 1 to 3 still run.

The workouts data source is a table, and each workout is one page (a row) in it. A data source id is not a database id; create the page with the data source as its parent.

1. Fetch the data source to learn the exact property names and types. Look at a few existing rows so your page matches them. Never write blind.
2. Create one page in the data source:
   - **Title:** `<workout name> (<local date>)`, in the same style as the existing rows.
   - **Body:** the full analysis in Markdown. Use the recipe's five sections in this order, with these exact headings: `**Verdict:**`, `**Key observations**`, `**Reasoning**`, `**Recommendations**`, `**Flags / concerns**`.
   - **Properties:** fill every property you have real source data for, matching its type. For select, multi-select and status properties, use only options that already exist in the schema, and never invent one. Leave a property blank if your value doesn't match an existing option or you aren't confident in it. Wrong values pollute later filtering.
3. Fetch the page back and confirm the title, body and properties landed. Fix anything that didn't.

## 5. Return the debrief

Your final message is the debrief and nothing else. Adam reads it to decide whether the workout is worth a text, so make it precise rather than friendly. Use plain text in this shape:

```
workout: <name, type, local date and time>
notion: <page url, or "dry run", or "not written: <reason>">
verdict: <the one-line verdict>
went well: <the single most important thing that went well, concrete>
to improve: <the single most important thing to change, concrete and actionable>
signals:
- plan: <a meaningful deviation from the plan, or "none">
- trend: <a recent trend continued or broken, or "none">
- pr or regression: <a personal best or a clear regression, or "none">
- recovery: <recovery data saying the session was a bad idea or should change the next one, or "none">
```

Fill a signal only when it is real and specific, and include the number that shows it. A routine session that went to plan has "none" for all four. Write that rather than stretching something minor into a signal.

If you couldn't write the page, still return the debrief and give the reason on the `notion:` line.

On a dry run, return the debrief, then a line containing only `---`, then the full five-section analysis you would have written to Notion.
