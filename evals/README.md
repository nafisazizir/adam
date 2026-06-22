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
   - LLM-judge (`t.judge.autoevals.closedQA`) for the soft traits: casual non-corporate
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
| reminder-absolute-time        | works out relative timing, no silent assumption |

## Running

```bash
eve eval personality            # run the whole suite locally
eve eval personality/roast      # one eval
eve eval personality --strict   # soft judge thresholds also fail the exit code
```

Evals boot a local dev server and call live models (Adam under test plus the judge),
so they need the same `.env` credentials the app uses and they cost tokens.

## Judge model

Set in `evals.config.ts`. Adam runs on a small model; the judge should be a stronger
one so grading is reliable and not self-flattering. Swap the model string there.
