# AGENTS.md

## What this repo is

**Adam** a proactive personal agent built on the **Eve** framework (Vercel's
filesystem-first framework for durable backend agents). Not a chatbot: a durable agent harness where
every trigger (inbound message, self-scheduled reminder, cron, external event) starts a session whose
first message is the trigger payload.

**`spec.md` is the source of truth.** Read it before doing design or implementation work — it carries
the vision, the architecture decisions, and the reasoning behind them (especially why one-shot
reminders use QStash, and why reminder _delivery_ is a channel rather than a tool). Keep `spec.md` in
sync when the architecture changes.

## Design in primitives, not one-off implementations

Before implementing a feature, identify the underlying capability and expose it as a small,
composable primitive — then build the feature on top. The payoff is that the next feature reuses the
primitive instead of duplicating logic, and a backend swap is a one-file change, not a rewrite. This
codebase is already built this way; preserve and extend it rather than special-casing:

When adding a capability, design the seam first: what's the primitive, who else will reuse it, and
what would have to change to swap its implementation? If the answer is "rewrite the feature," the
seam is in the wrong place.

## Eve mental model (read the docs, don't guess)

Eve's behaviour is specific and easy to get wrong from memory. The bundled docs match the installed
version exactly — **always read them before writing Eve code**:

- Pre-scaffold: `.agents/skills/eve/docs/README.md` (this repo's Eve checkout).
- Post-scaffold: `node_modules/eve/docs/README.md`.

Core rules that shape this codebase:

- **Identity comes from the path.** `agent/tools/get_weather.ts` → tool `get_weather`. Never write a
  `name`/`id` field on a `define*` call. Tool filenames must be snake_case.
- **Authored slots under `agent/`:** `tools/`, `channels/`, `connections/`, `schedules/`,
  `subagents/`, `skills/`, `lib/`, `instructions.md`, `agent.ts`. `lib/` is import-only (never mounted
  into the sandbox).
- **`channels/` and `schedules/` are root-only** — declared subagents cannot have them.
- **Declared subagents inherit nothing** from the root; each is its own agent root and must duplicate
  any tools/connections/skills it needs.
- **Sessions are durable by default** (built on the Workflow SDK). You do not write workflow code;
  there is **no author-accessible `sleepUntil`/timer**. The experimental `Workflow` tool only
  orchestrates subagents (QuickJS, no network, no timers).
- **`defineState` is per-session** working memory; it does not cross sessions or reach subagents.
  Anything cross-session/cross-user belongs in an external store.

## Architecture (the big picture)

The whole app is the trigger → session → maybe-reply loop. The non-obvious structural decision:

- **Scheduling a reminder is a tool** (`schedule_reminder`), called by the model mid-turn; it
  publishes to QStash via `lib/qstash.ts`. **Delivering a reminder is a channel** (`channels/reminders.ts`):
  at fire-time no agent is running, so QStash makes an inbound HTTP POST to a route, and only a
  channel can receive inbound HTTP _and start a fresh session_ (via `receive(telegram, …)`). Delivery
  re-enters the agent on purpose, so it can exercise right-to-silence, recall context, and compose —
  not blindly send a string.
- **`receive(channel, { message, target, auth })`** is the primitive for starting a session without
  an inbound user message (used by the `reminders` channel and by cron schedules). Only channels and
  schedules have it.
- **Schedules (`agent/schedules/`) are cron and periodic only** (daily `briefing`) — never the
  reminder timer. Vercel Hobby cron is ~once/day, so minute-level timing intentionally goes through
  QStash, not cron.
- **All env goes through `agent/lib/env.ts`** — the single place that parses/validates/sanitises
  `process.env` (zod). Consume typed values from there, never raw `process.env`. Derived values live
  there too (e.g. `remindersDeliverUrl = \`${BASE_URL}/eve/v1/reminders/deliver\``), so the deliver
URL is computed from `BASE_URL`, not its own env var.

## Conventions

- **Comments are minimal — treat them as a code smell.** Make the code self-explanatory through clear
  names and small functions instead. Don't narrate what the code already says, don't restate types,
  and never leave commented-out code. Reserve a comment for the rare _why_ that the code can't show:
  a non-obvious constraint, a workaround, a deliberate trade-off. If a comment is needed to explain
  _what_ something does, refactor until it isn't.
- **Scope discipline:** v1 is single-user, Telegram-only, no Redis. Cross-session memory, multi-user,
  multi-channel, and specialist subagents (`coach`, `inbox`, `finance`) are explicitly deferred — see
  `spec.md` §7–8 before adding any of them.
