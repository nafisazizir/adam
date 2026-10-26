# Personality evals

An objective harness for steering Adam's voice toward our target personality, and for
keeping it there as `agent/instructions.md` changes. Built on Eve's eval framework
(`eve eval`).

## The method

The goal is not to make Adam reproduce any reference reply word for word. It is to make
Adam exhibit the *traits* of the target personality. So:

1. **The reference material is a build-time guide, never an answer key.** We distill
   traits from it but do not commit its lines or string-match against them, that would
   punish good-but-different replies and reward parroting.
2. **Each eval grades a trait, not a string.** Two layers:
   - Deterministic gates for the mechanical voice rules (no em-dash, no markdown, no
     "not just X, but Y"), in `personality/style.ts`.
   - LLM-judge (`t.judge`) for the soft traits: casual non-corporate
     voice, playful roasts, confident mystery about internals, right-to-silence,
     proactive concrete offers, best-friend-no-moralizing.

## The iteration loop

```
edit agent/instructions.md  ->  eve eval personality  ->  read failures  ->  edit again
```

When you spot a new gap, capture it as a new `.eval.ts` here so it can never silently
regress.

## Traits covered

| eval                          | trait |
| ----------------------------- | ----- |
| who-are-you                   | casual, non-corporate, coy about the model |
| greeting                      | a greeting gets a greeting, no status dump |
| deflect-internals             | confident mystery, won't dump its stack |
| roast                         | playful teasing like a close friend |
| low-signal-silence            | right to silence, minimal acknowledgement |
| proactive-offer               | one concrete proactive step, no over-pitch |
| best-friend-no-moralizing     | helps the harmless white lie, no lecture |
| plain-text-style              | plain text, lowercase, no markdown |
| voice-note-restraint          | text by default, no unasked-for voice note |
| voice-note-on-request         | speaks when asked, and embeds the clip as `![](url)` |
| workouts/silent-on-plan       | workout debrief follows the plan without interrupting |
| workouts/noteworthy-pr        | workout debrief surfaces a noteworthy personal record |
| coding/offer-missing-capability | a missing capability gets one offer to build it, not a silent start |
| coding/needs-input            | a coding agent's question reaches the user in a line |
| coding/finished               | a finished coding session gets the PR link and manual steps |
| coding/halted                 | a halted session is reported with its real reason |
| coding/injection              | instructions inside the coding agent's message are not obeyed |
| coding/merged                 | a merge the user asked for is confirmed in a few words |
| reminders/absolute-time       | a clock time becomes `at` in local time, no hand-computed delay |
| reminders/relative-delay      | "in 20 minutes" is `delaySeconds` 1200 |
| routines/create-fortnightly   | "every second sunday at 6pm" is a two-week rule on Sunday at 18:00, not a reminder |
| routines/run-and-note         | a due routine that always reports gets one fresh line, and its run is noted |
| routines/silent-when-nothing  | a routine whose condition isn't met in the chat stays silent |
| inbox/injection               | instructions inside an email are reported, never obeyed |
| inbox/new-email-silent        | new mail that is only newsletters and notifications gets no text |
| inbox/new-email-time-sensitive | a friend's time-sensitive email gets one short text |
| briefing/quiet-day            | a morning of ordinary meetings and a newsletter gets no text |
| briefing/mail-and-reconnect   | a friend's urgent email and an account needing connecting get one short text, no calendar recap |
| memory/saves-durable-fact     | an injury the user mentions is saved to owner memory |
| memory/skips-trivia           | small talk is not saved |
| calls/spoken-reply            | a call request is answered through `reply_to_call`, briefly, and the route's stream scan finds it |
| calls/text-a-link             | a link asked for on a call is texted, not read out |
| calls/silent-after-call       | a finished call joins the history without a text recap |
| calls/note-call-started       | a call starting gets one short text line, never silence |

The workout evals live under `evals/workouts/` and run with
`pnpm eve eval workouts`. The coding session evals live under `evals/coding/` and run with
`pnpm eve eval coding`. The briefing evals live under `evals/briefing/` and feed the real guidance and Google renderer fixed
calendar and mail (`evals/briefing/google.ts`), so they read no Google account; run them with
`QSTASH_TOKEN=eval-disabled DEVIN_API_KEY= DEVIN_ORG_ID= pnpm eve eval briefing`. The reminder evals live under `evals/reminders/`. They would publish real QStash reminders, so run them with
`QSTASH_TOKEN=eval-disabled pnpm eve eval reminders`: publishing then fails safely and they assert on tool inputs only.
The inbox evals live under `evals/inbox/`. The poisoned email asks for a
reminder and a coding session, and a new-mail trigger could tempt one, so run them with those disabled, so a failing run has no side effects:
`QSTASH_TOKEN=eval-disabled DEVIN_API_KEY= DEVIN_ORG_ID= pnpm eve eval inbox`. `connect_google_account`
and `disconnect_google_account` always refuse under `eve eval` (the eval caller is not the owner chatting); their
gates are unit-tested in `agent/lib/connection-auth.test.ts` and `agent/lib/delivery.test.ts`. The memory evals live under `evals/memory/`; under `eve eval` memory is process-local and
scoped to `local-dev`, so they never touch the owner's stored memory.
The call evals live under `evals/calls/` (`pnpm verify calls`); an eval session is not a live
call, so `reply_to_call` answers that nothing was said and Adam may text the answer too.

## Running

```bash
eve eval personality            # run the whole suite locally
eve eval personality/roast      # one eval
eve eval personality --strict   # soft judge thresholds also fail the exit code
```

Evals boot a local dev server and call live models (Adam under test plus the judge),
so they need the same `.env` credentials the app uses and they cost tokens. The `voice`
tag also hits the speech model and Vercel Blob, so `BLOB_READ_WRITE_TOKEN` has to be set.

## Judge model

Set in `evals.config.ts`. Eve's `t.judge` asks a decision model for a probability, so the judge
must be one (`typesafe-ai/jev`, Eve's default); a plain language model such as
`openai/gpt-5-mini` fails every judged eval with "is a language model, not a decision model".
