# Adam — Proactive Personal Agent

> An open-source, proactive personal assistant built on **Eve**. Not a chatbot — a durable agent
> harness with multiple trigger sources, where the messaging channel is just the UI.
> Vercel-native, free-tier-first, low-maintenance.

---

## 1. Vision

Adam is the open-source answer to Poke (Interaction Company's proactive iMessage assistant). The
insight Adam is built around: a proactive assistant is **not a chatbot**, it's an _agent harness_
where reactive and proactive collapse into one model —

> **`trigger → agent run → (maybe) send a message`**

The channel (iMessage, via Photon) is just the surface. What makes Adam feel _alive_ rather than reactive
is that it can wake itself up — on a timer it set, on an external event, or on a schedule — and it
exercises **the right to silence**: most events are not worth interrupting a human for, and Adam is
expected to decide that.

### Design principles

- **Everything is a trigger.** Inbound message, self-scheduled reminder, cron sweep, external event
  — all produce a session whose _first message is the trigger payload_.
- **Right to silence.** Default to _not_ messaging. Proactivity that spams is worse than none.
- **Fewest services, free, low-maintenance.** Lean on the framework; add a service only when it
  sources a capability nothing free provides.
- **Filesystem-first.** Every capability is a file on disk (Eve's model). The repo _is_ the agent.

---

## 2. Why Eve

Eve is a filesystem-first framework for **durable backend agents** (Vercel). An agent is a directory;
instructions, tools, channels, connections, subagents, and schedules are all files, and Eve compiles
and runs it. It collapses almost the entire hand-rolled stack we'd otherwise build:

| Need                                                | Eve provides                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhooks / HTTP routing                             | **Channels** (`photon.ts` mounts its own webhook)                                                                                            |
| Durability / crash-safety / retries                 | **Built-in** — every turn is a durable workflow (Workflow SDK under the hood); sessions survive redeploys                                    |
| Per-user, per-channel chat history + context window | **Durable sessions** keyed by `continuationToken`; history is append-only + durable; **compaction** manages the context window automatically |
| Conversation-scoped working memory                  | **`defineState`** (durable per-session)                                                                                                      |
| Model/provider abstraction                          | Native — `model:` routes through **Vercel AI Gateway**                                                                                       |
| External tools (riz-mcp, Strava, Gmail)             | **Connections** (`defineMcpClientConnection` / OpenAPI)                                                                                      |
| Specialist agents                                   | **Declared subagents** (`agent/subagents/<id>/`)                                                                                             |
| Recurring jobs                                      | **Schedules** (`agent/schedules/*.ts`, become Vercel Cron)                                                                                   |

**Key consequence:** we do **not** build our own conversation store. Each iMessage thread is its own Eve session, durable and compacted. "Redis for fast per-user
history" is something Eve _already is_.

Docs (bundled with the `eve` npm package): `node_modules/eve/docs/README.md`.

---

## 3. The one hard problem: timed one-shot delivery

Reminders need "deliver at a future instant" ("nudge me 15 min before the workout"). Nothing in the
free Eve/Vercel stack provides this:

- **Eve cron is recurring-only**, and **Vercel Hobby cron runs at most ~once/day** — useless for
  "in 15 min."
- **The Workflow SDK's `sleepUntil` is not author-accessible.** Eve uses it internally for
  durability, but the only author-facing "workflow" is the experimental `Workflow` _tool_, a QuickJS
  subagent orchestrator with no network and no timers.

### Decision: Upstash QStash

A hosted "call this URL at time T with this body" service — exact, retried, signature-verified, free
tier, fully managed (≈ no maintenance), same vendor as the Redis we add later. `list`/`cancel` go
through QStash's own messages API, so **v1 needs no Redis at all.**

#### The reminder loop

```
schedule_reminder ──> QStash.publishJSON({ url: env.remindersDeliverUrl, notBefore: fireAt, body })
                                          │  (QStash holds it durably until fireAt)
                                          ▼
        POST https://<app>/eve/v1/reminders/deliver
                                          ──> verify Upstash-Signature
                                          ──> receive(photon, { message: context, target:{threadId}, auth })
                                          ──> session starts, message lands on the phone
list_reminders / cancel_reminder ───────> QStash messages API
```

The URL QStash hits is **our own deployment's public route** (the `reminders` or `workouts` custom
channel). It must be public HTTPS — QStash can't reach `localhost` (use a tunnel for local e2e, or
stub the route).

---

## 4. Architecture

```
                       ┌─────────────── Triggers ───────────────┐
   Photon webhook   ──▶│ inbound iMessage (reactive)            │
   QStash callback  ──▶│ one-shot reminder / workout callbacks  │──▶ Eve session ──▶ (maybe) reply
   Vercel Cron      ──▶│ periodic briefing/sweep                │      (durable)        via channel
   Strava/Hevy      ──▶│ completed workout (workouts channel)   │
   (future) webhooks──▶│ external events (email)                 │
                       └────────────────────────────────────────┘
                                         │
                 every trigger's payload becomes the session's first message
```

- **Channels** (`agent/channels/`): `photon` (reactive UI + delivery), plus
  `reminders` (custom channel; QStash callback endpoint that hands off to whichever delivery channel
  the reminder was scheduled from, via `receive`), and `workouts` (Strava/Hevy webhooks plus
  QStash analysis and nudge callbacks). Analysis is queued immediately on webhook arrival, matching
  riz-mcp, while QStash still provides deduplication and retries; it starts an independent session at
  `strava:<id>` or `hevy:<id>`. Strava activity details are fetched through riz-mcp; `WeightTraining`
  and `Walk` activities are deterministically skipped, matching riz-mcp. The session delegates to
  `coach` and returns its debrief. A completed coach response queues one nudge to the user's home
  iMessage thread; root Adam applies right-to-silence there.
  Separate sessions cannot be steered or cancelled by an iMessage arriving during analysis, and the
  workout address doubles as its idempotency key. Ingress and nudge use separate QStash
  deduplication IDs, retained for 90 days, for at most one analysis and one message per workout.
- **Delivery channels** (`agent/lib/delivery.ts`): the seam that keeps the reminder loop
  channel-agnostic. Each entry projects a session's auth context to a `{ channel, target }` pair and
  knows how to `receive` back into it. `homeDelivery()` provides the last chat the user messaged
  from, remembered by `lib/home-target.ts` in Vercel Blob. Adding a messaging surface is a channel
  file plus one entry here.
- **Workout coach** (`agent/subagents/coach/`): uses `openai/gpt-6.1-sol`, riz-mcp and an
  app-scoped Notion connection, plus the vendored riz-mcp skill and `workout-debrief` skill. The
  model choice suits focused coaching; keeping raw workout data in the coach's context avoids
  dumping it into the user's chat; and the Notion connection is available only to the coach.
- **Shared primitives**: `publishCallback` and `verifyCallbackSignature` in `lib/qstash.ts`;
  `homeDelivery` in `lib/delivery.ts`; the single delivery-routing pointer in `lib/home-target.ts`;
  `callRizMcpTool` in `lib/riz-mcp.ts`; and workout auth, message builders, sport skips, and the
  shared workout reference schema in `lib/workouts.ts`.
- **Tools** (`agent/tools/`): `schedule_reminder`, `cancel_reminder`, `list_reminders`, `generate_speech`.
  Later: memory tools, plus connection-provided tools.
- **Outbound media** (`agent/lib/outbound.ts`): one primitive for everything the model attaches. The
  model writes `![](url)`; `renderOutbound` fetches the url, keeps it only if its content type is in
  the allowlist (`image/*` plus common audio types), and hands the bytes to the channel. The Photon
  channel sends audio through its native voice-note path and everything else as an attachment, so
  generated speech gets iMessage's waveform UI instead of a downloadable file. An unreachable or
  disallowed url degrades to a raw link in the text. `lib/speech.ts` (text → audio, via the AI
  Gateway) and `lib/assets.ts` (bytes → url, via a **private** Vercel Blob store) are the two seams
  behind `generate_speech`; a different TTS provider or blob store is a one-file change.
  Nothing Adam generates is ever world-readable: the url is only a handle, and `readAsset` is the
  one thing that can turn it back into bytes (authenticated, server-side). Hosting is also a
  handoff rather than storage — `renderOutbound` reports the urls it turned into files and the
  channel calls `releaseAssets` once iMessage has its own copy. Urls Adam did not publish are
  fetched plainly and never deleted.
- **Schedules** (`agent/schedules/`): `briefing` (daily, Hobby-safe). Periodic only — _never_ the
  reminder timer.
- **Instructions** (`agent/instructions.md`): personality + right-to-silence + when-to-nudge. This
  is the actual product surface; right-to-silence is applied to workout debriefs when they re-enter
  the user's iMessage thread.

---

## 5. Project layout

```
adam/
├── package.json               # name "adam" → agent name
├── spec.md                    # this document
├── agent/
│   ├── agent.ts               # model: deepseek/deepseek-v4-flash-0731
│   ├── instructions.md        # personality, right-to-silence, when to nudge
│   ├── channels/
│   │   ├── photon.ts          # photonIMessageChannel: iMessage via Photon (Spectrum Cloud)
│   │   ├── reminders.ts       # defineChannel: POST /deliver → verify sig → receive(<delivery channel>,…)
│   │   └── workouts.ts        # Strava/Hevy webhooks and signed QStash callbacks
│   ├── connections/
│   │   └── riz-mcp.ts
│   ├── subagents/
│   │   └── coach/
│   │       ├── agent.ts
│   │       ├── instructions.md
│   │       ├── connections/
│   │       │   ├── notion.ts  # app-scoped; coach only
│   │       │   └── riz-mcp.ts
│   │       └── skills/
│   │           ├── riz-mcp/   # vendored from nafisazizir/riz-mcp
│   │           └── workout-debrief/
│   ├── lib/
│   │   ├── env.ts             # single source of truth: parse/validate/sanitise env; derive callback URLs
│   │   ├── delivery.ts        # delivery registry plus homeDelivery
│   │   ├── home-target.ts     # last chat the user messaged from, in private Vercel Blob
│   │   ├── workouts.ts        # workout auth, messages, address, and shared ref schema
│   │   ├── riz-mcp.ts         # shared connection config and callRizMcpTool
│   │   ├── outbound.ts        # bubble splitting + `![](url)` → real attachments (image/* and audio)
│   │   ├── speech.ts          # text → audio bytes (AI Gateway speech model)
│   │   ├── assets.ts          # bytes ↔ url (private Vercel Blob), dropped after delivery
│   │   └── qstash.ts          # callback publishing, reminder APIs, signature verify
│   ├── tools/
│   │   ├── schedule_reminder.ts
│   │   ├── cancel_reminder.ts
│   │   ├── list_reminders.ts
│   │   └── generate_speech.ts # speak text, upload, return the url the model embeds
│   └── schedules/
│       └── briefing.ts        # daily cron only
├── scripts/
│   ├── sync-riz-mcp-skill.ts
│   └── riz-mcp-skill.lock.json
└── .env
```

---

## 6. State & memory model

- **Per-session working memory** → `defineState` (durable, dies with the session).
- **Per-(channel, user) conversation history + context window** → **Eve durable sessions**
  (built-in; nothing to build).
- **Cross-session long-term memory** (durable facts that span sessions/channels) → **deferred to the
  Redis layer** (§8). For v1 single-user, the per-chat session _is_ the memory.

---

## 7. v1 scope & non-goals

**In:** iMessage round-trip · `schedule_reminder` + `reminders` delivery via QStash · daily
`briefing` cron · Strava/Hevy workout debriefs via the `coach` subagent · right-to-silence
instructions · outbound image and audio attachments, with `generate_speech` for the occasional
voice note (text stays the default; see `agent/instructions.md`).

**Out (deferred):** Redis / cross-session memory · multi-user · multi-channel · `inbox` and `finance`
subagents · email integration · inbound burst debouncing (low-risk single-user; add a Photon
`onMessage` buffer only if it bites).

### Environment variables

All env is parsed, validated, and sanitised in one place — `agent/lib/env.ts` (zod) — and consumed
from there, never via raw `process.env`. Derived values live there too, so the deliver URL is **not**
its own env var; it's computed from `BASE_URL` as `remindersDeliverUrl = \`${BASE_URL}/eve/v1/reminders/deliver\``.

```
BASE_URL=...                        # app's public origin, e.g. https://adam.vercel.app (deliver URL derived in env.ts)
IMESSAGE_PROJECT_ID=...             # Photon project
IMESSAGE_PROJECT_SECRET=...
IMESSAGE_WEBHOOK_SECRET=...         # verify inbound Photon webhook
QSTASH_TOKEN=...                    # publish reminders
QSTASH_CURRENT_SIGNING_KEY=...      # verify callback signature
QSTASH_NEXT_SIGNING_KEY=...
AI_GATEWAY_API_KEY=...              # or ANTHROPIC_API_KEY; also routes the speech model
BLOB_READ_WRITE_TOKEN=...           # optional; private Vercel Blob store for generated audio and the home delivery target
SPEECH_MODEL=...                    # optional, defaults to openai/tts-1
SPEECH_VOICE=...                    # optional, defaults to alloy
STRAVA_WEBHOOK_VERIFY_TOKEN=...     # Strava GET handshake
STRAVA_WEBHOOK_SUBSCRIPTION_ID=...  # optional; unset fails closed and ignores events
HEVY_WEBHOOK_SECRET=...             # Hevy Authorization header
NOTION_PLANS_DATA_SOURCE_ID=...     # coach's training plan data source
NOTION_WORKOUTS_DATA_SOURCE_ID=...  # coach's workout analyses data source
```

### Deployment notes

- Deploy to Vercel; schedules become Vercel Cron (verify under Settings → Cron Jobs).
- Point the Photon project's webhook at the deployed `photon` channel route after deploy. Re-run if
  the URL changes.
- Strava allows one webhook subscription per app, so the old and new flows cannot receive events
  simultaneously. In riz-mcp, run `npm run webhook:strava delete <old>` and then
  `npm run webhook:strava create ${BASE_URL}/eve/v1/workouts/strava`; set the returned
  `STRAVA_WEBHOOK_SUBSCRIPTION_ID` in Adam's environment.
- Set the Hevy webhook URL to `${BASE_URL}/eve/v1/workouts/hevy`.
- Set up the coach's app-scoped Notion connection with `eve add connection/notion --skip-install`.
  Configure both Notion data source IDs in Adam's environment.
- Workout nudges require a connected private Vercel Blob store and are skipped until the user has
  texted Adam once after deploy; that chat becomes the remembered home delivery target.
- The coach is billed per token through AI Gateway.
- Refresh and verify the vendored coaching skill with `pnpm sync:riz-mcp-skill --from …` and
  `pnpm sync:riz-mcp-skill --check`.
- QStash free tier ≈ 500 msgs/day — fine for personal use; confirm current limits.

---

## 8. Roadmap

Ordered roughly by value. Each specialist is a **declared subagent** (`agent/subagents/<id>/`,
own instructions/tools/connections; inherits nothing from root).

1. **Cross-session memory + the Redis layer.** When multi-user/multi-channel arrives, Eve still owns
   per-`(channel, user)` history. **Redis becomes the _identity + long-term memory_ layer, NOT
   history:** durable per-user facts keyed `user:<id>` that span sessions/channels, plus mapping an
   iMessage handle + a WhatsApp number to the same logical user. (Postgres/pgvector if memory needs
   semantic recall.)
2. **Extend `coach`.** Post-workout debriefs are built with riz-mcp and Notion. Pre-session reminders
   based on its recommendations, about 15 minutes before the next workout, remain roadmap.
3. **Multi-channel.** iMessage (`photon`) is the primary surface; WhatsApp and friends are a file in `channels/`
   plus an entry in `lib/delivery.ts`. The trigger model and reminder loop are channel-agnostic
   (`receive` takes any channel; reminder payloads carry `{ channel, target }`).
4. **`inbox`.** Gmail connection; triages mail, exercises right-to-silence, schedules follow-ups.
5. **`finance`.** Spend tracking, anomaly surfacing, weekly summary (cron).
6. **Orchestration.** Enable the experimental `Workflow` tool to fan out subagents (e.g. a weekly
   "life review" running `coach` + `finance` in parallel and merging).
7. **External event triggers.** Strava/Hevy workout webhooks are built in `workouts`; email
   integration remains roadmap.
8. **Multi-user hardening.** Per-user Connect OAuth for connections, per-user reminder/memory keys,
   auth on inbound routes.

---

## 9. Glossary (mental model)

- **Trigger** — anything that starts a session: inbound message, reminder callback, cron, webhook.
- **Session** — one durable conversation/task in Eve; owns its history; survives redeploys.
- **Turn** — one user message + all work it triggers until a response.
- **Channel** — an HTTP/messaging entrypoint (`agent/channels/`); owns inbound parsing + delivery.
- **`receive(channel, …)`** — start a session on a channel without an inbound message (proactive send).
- **Connection** — an external MCP/OpenAPI server surfaced to the model as tools.
- **Subagent** — a child agent for a focused role, with its own tools/connections.
- **Right to silence** — the agent's explicit option to do nothing on a trigger.

---

## 10. References

- Eve docs: `node_modules/eve/docs/` (bundled with the `eve` package).
- Poke (Interaction Company) — the proactive iMessage assistant Adam reimagines for OSS.
- OpenPoke — open reconstruction of Poke's interaction/execution agent split.
- caltext (pontusab) — prior-art app on a similar stack (Hono/Chat SDK/Sendblue/Upstash/Workflow);
  read for integration patterns, not forked.
