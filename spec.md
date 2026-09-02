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

The URL QStash hits is **our own deployment's public route** (the `reminders` custom channel). It
must be public HTTPS — QStash can't reach `localhost` (use a tunnel for local e2e, or stub the route).

---

## 4. Architecture

```
                       ┌─────────────── Triggers ───────────────┐
   Photon webhook   ──▶│ inbound iMessage (reactive)            │
   QStash callback  ──▶│ one-shot reminder (self-scheduled)     │──▶ Eve session ──▶ (maybe) reply
   Vercel Cron      ──▶│ periodic briefing/sweep                │      (durable)        via channel
   (future) webhooks──▶│ external events (Strava, email)        │
                       └────────────────────────────────────────┘
                                         │
                 every trigger's payload becomes the session's first message
```

- **Channels** (`agent/channels/`): `photon` (reactive UI + delivery), plus
  `reminders` (custom channel; QStash callback endpoint that hands off to whichever delivery channel
  the reminder was scheduled from, via `receive`).
- **Delivery channels** (`agent/lib/delivery.ts`): the seam that keeps the reminder loop
  channel-agnostic. Each entry projects a session's auth context to a `{ channel, target }` pair and
  knows how to `receive` back into it. Adding a messaging surface is a channel file plus one entry
  here.
- **Tools** (`agent/tools/`): `schedule_reminder`, `cancel_reminder`, `list_reminders`, `generate_speech`.
  Later: memory tools, plus connection-provided tools.
- **Outbound media** (`agent/lib/outbound.ts`): one primitive for everything the model attaches. The
  model writes `![](url)`; `renderOutbound` fetches the url, keeps it only if its content type is in
  the allowlist (`image/*` plus common audio types), and hands the bytes to the channel as a file.
  Attachment kinds are an allowlist entry, not a code path, and an unreachable or disallowed url
  degrades to a raw link in the text. `lib/speech.ts` (text → audio, via the AI Gateway) and
  `lib/assets.ts` (bytes → url, via a **private** Vercel Blob store) are the two seams behind
  `generate_speech`; a different TTS provider or blob store is a one-file change.
  Nothing Adam generates is ever world-readable: the url is only a handle, and `readAsset` is the
  one thing that can turn it back into bytes (authenticated, server-side). Hosting is also a
  handoff rather than storage — `renderOutbound` reports the urls it turned into files and the
  channel calls `releaseAssets` once iMessage has its own copy. Urls Adam did not publish are
  fetched plainly and never deleted.
- **Schedules** (`agent/schedules/`): `briefing` (daily, Hobby-safe). Periodic only — _never_ the
  reminder timer.
- **Instructions** (`agent/instructions.md`): personality + right-to-silence + when-to-nudge. This
  is the actual product surface.

---

## 5. Project layout

```
adam/
├── package.json               # name "adam" → agent name
├── spec.md                    # this document
├── agent/
│   ├── agent.ts               # model: anthropic/claude-sonnet-4.6
│   ├── instructions.md        # personality, right-to-silence, when to nudge
│   ├── channels/
│   │   ├── photon.ts          # photonIMessageChannel: iMessage via Photon (Spectrum Cloud)
│   │   └── reminders.ts       # defineChannel: POST /deliver → verify sig → receive(<delivery channel>,…)
│   ├── lib/
│   │   ├── env.ts             # single source of truth: parse/validate/sanitise env (zod); derive remindersDeliverUrl from BASE_URL
│   │   ├── delivery.ts        # delivery-channel registry: auth → { channel, target } → receive
│   │   ├── outbound.ts        # bubble splitting + `![](url)` → real attachments (image/* and audio)
│   │   ├── speech.ts          # text → audio bytes (AI Gateway speech model)
│   │   ├── assets.ts          # bytes ↔ url (private Vercel Blob), dropped after delivery
│   │   └── qstash.ts          # publish / list / cancel + signature verify
│   ├── tools/
│   │   ├── schedule_reminder.ts
│   │   ├── cancel_reminder.ts
│   │   ├── list_reminders.ts
│   │   └── generate_speech.ts # speak text, upload, return the url the model embeds
│   └── schedules/
│       └── briefing.ts        # daily cron only
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
`briefing` cron · right-to-silence instructions · outbound image and audio attachments, with
`generate_speech` for the occasional voice note (text stays the default; see
`agent/instructions.md`).

**Out (deferred):** Redis / cross-session memory · multi-user · multi-channel · specialist subagents
· external-event webhooks · inbound burst debouncing (low-risk single-user; add a Photon
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
BLOB_READ_WRITE_TOKEN=...           # optional; from a private Vercel Blob store ("add a read-write token env var"), holds generated audio
SPEECH_MODEL=...                    # optional, defaults to openai/tts-1
SPEECH_VOICE=...                    # optional, defaults to alloy
```

### Deployment notes

- Deploy to Vercel; schedules become Vercel Cron (verify under Settings → Cron Jobs).
- Point the Photon project's webhook at the deployed `photon` channel route after deploy. Re-run if
  the URL changes.
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
2. **`coach` (flagship subagent).** riz-mcp + Strava connections. On a new analyzed workout, computes
   next-session recs and calls `schedule_reminder` for ~15 min before the next session. Will still need a bit more work to fit into this architecture, but you'll get the vision.
3. **Multi-channel.** iMessage (`photon`) is the primary surface; WhatsApp and friends are a file in `channels/`
   plus an entry in `lib/delivery.ts`. The trigger model and reminder loop are channel-agnostic
   (`receive` takes any channel; reminder payloads carry `{ channel, target }`).
4. **`inbox`.** Gmail connection; triages mail, exercises right-to-silence, schedules follow-ups.
5. **`finance`.** Spend tracking, anomaly surfacing, weekly summary (cron).
6. **Orchestration.** Enable the experimental `Workflow` tool to fan out subagents (e.g. a weekly
   "life review" running `coach` + `finance` in parallel and merging).
7. **External event triggers.** Strava/email webhook → custom channel route → `receive` a session.
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
