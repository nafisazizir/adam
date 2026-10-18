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
   QStash callback  ──▶│ reminder / workout / coding callbacks  │──▶ Eve session ──▶ (maybe) reply
   Vercel Cron      ──▶│ periodic briefing/sweep                │      (durable)        via channel
   Strava/Hevy      ──▶│ completed workout (workouts channel)   │
   (future) webhooks──▶│ external events (email)                 │
                       └────────────────────────────────────────┘
                                         │
                 every trigger's payload becomes the session's first message
```

- **Channels** (`agent/channels/`): `photon` (reactive UI + delivery), plus
  `reminders` (custom channel; QStash callback endpoint that hands off to whichever delivery channel
  the reminder was scheduled from, via `receive`; it answers 500 when the hand-off to the delivery
  channel fails so QStash retries (a later failure posting to the phone is not retried), and
  `schedule_reminder` publishes with a deduplication id derived from the session, turn, message and the model-given time (`at` with `leadMinutes`, or `delaySeconds`)
  (`lib/replay-key.ts`), so a re-run step does not schedule a second copy within QStash's
  ten-minute window),
  and `workouts` (Strava/Hevy webhooks plus
  QStash analysis and nudge callbacks). Analysis is queued immediately on webhook arrival, matching
  riz-mcp, while QStash still provides deduplication and retries; it starts an independent session at
  `strava:<id>` or `hevy:<id>`. Strava activity details are fetched through riz-mcp; `WeightTraining`
  and `Walk` activities are deterministically skipped, matching riz-mcp. The session delegates to
  `coach` and returns its debrief. A completed coach response queues one nudge to the user's home
  iMessage thread; root Adam applies right-to-silence there. The debrief ends with a
  `next session: <what> | <local YYYY-MM-DDTHH:mm or "unscheduled">` line, filled only from a concrete time in the plan;
  root then calls `schedule_reminder` with `at` and `leadMinutes: 15`, silently. `schedule_reminder` takes either
  `delaySeconds` or `at` (a local wall-clock time converted in `lib/zoned-time.ts`, DST-safe) plus optional
  `leadMinutes`; a lead reminder under 5 minutes away returns `{ skipped: "too soon" }`; a plain `at` in the past is an error.
  Separate sessions cannot be steered or cancelled by an iMessage arriving during analysis, and the
  workout address doubles as its idempotency key. Ingress and nudge use separate QStash
  deduplication IDs (QStash remembers them for only ten minutes) for at most one analysis and one message per workout.
- **Delivery channels** (`agent/lib/delivery.ts`): the seam that keeps the reminder loop
  channel-agnostic. Each entry projects a session's auth context to a `{ channel, target }` pair and
  knows how to `receive` back into it. `homeDelivery()` provides the last direct chat the owner
  messaged from and who they are, remembered by `lib/home-target.ts` in Vercel Blob. Adding a messaging
  surface is a channel file plus one entry here.
- **Only the owner** (`admitSender` in `agent/lib/owner.ts`): the photon `onMessage` drops every
  message not from the owner (returns `null` and logs the sender's handle and the reason, never the
  content), so no one else starts a turn, steers one, answers a confirmation, or moves the home
  pointer. A handle is the sender's iMessage address as Photon reports it (`message.author.userId`):
  a phone number in E.164 with country code (`+61412345678`) or an Apple ID email, and the two are
  different handles. When `OWNER_IMESSAGE_HANDLES` (comma-separated) is set it is the authority:
  only listed handles get in, and they all act as the pointer's `owner.principalId` if that is
  listed, otherwise as the first listed handle in canonical form. When it is unset, the owner is the
  pointer's `owner.principalId`; with no pointer either, the first person to text Adam directly
  claims ownership, logged as `[photon] <handle> claimed ownership`. One principal for every alias
  keeps `home.owner` and user-scoped Connect grants from moving; only the home thread follows the
  latest direct chat. Handles compare exactly, apart from ASCII case for emails and spacing and
  punctuation for numbers. Only a 404 counts as "no owner yet": a pointer that is not JSON, fails
  the schema, names another issuer, or cannot be read drops every message, and without a Blob store
  only listed handles get in. A first claim is written with `allowOverwrite: false` before it is
  cached or admitted, so two people texting a fresh install at once cannot both become the owner
  and a failed write drops the message. After that, a recorded owner is cached per instance;
  nothing else is.
  SMS and RCS senders are refused: Apple authenticates an iMessage handle, while an SMS or RCS
  originator can be spoofed. `sentOverAnotherService` in `lib/photon-inbound.ts` reads the sender's
  `service`, falling back to the webhook's `platform`, and refuses only a sender marked `SMS` or
  `RCS` (any case), so the owner's own SMS fallback during an iMessage outage is dropped too. A
  payload naming no service, or another one such as `unknown`, is admitted rather than locking the
  owner out; Photon's webhook documents only
  `platform`, so an SMS that Photon labels `iMessage` would still pass; the line is an iMessage line.
  Only a direct (1:1) chat claims ownership or moves the home pointer, decided by the adapter's
  `isDM` (`;-;` in the chat GUID). In a group chat Adam answers the owner's messages and ignores
  everyone else's; its context says others can read the replies, and a sign-in link is never posted
  there, Adam asks the owner to text directly instead. The photon auth carries `thread_id` and
  `direct` (`"true"`/`"false"`, from `ctx.thread.isDM` on the inbound message).
- **Owner-chat gates** (`isOwnerChat`, `isOwnerDirectChat` in `agent/lib/delivery.ts`): because only
  the owner reaches a photon turn, an auth that `deliveryChannelForAuth` resolves means "the owner is
  chatting"; background turns (debriefs, coding updates, the briefing, reminders) keep their own
  authenticators and never resolve. `isOwnerChat` gates anything that needs the owner's say-so in
  chat (merge confirmations, memory writes). `isOwnerDirectChat` also requires `direct: "true"` and
  gates anything that hands out a link granting access to the owner's accounts (sign-in and consent
  links): in a group anyone could open it first and connect their own account in the owner's name.
  A tool that mints such a link refuses outside it with "Text me directly and ask again".
- **Acting as the owner** (`agent/lib/owner.ts`): `ownerAuth(owner, source)` builds a user-principal
  auth context keyed to the owner's chat identity while keeping the trigger's own `authenticator`.
  User-scoped connections key grants by issuer and principal id, so workout runs reuse the grant the
  owner approved over iMessage instead of failing with `principal_required`.
- **Owner memory** (`agent/memory/owner.ts`, `lib/owner-memory.ts`): one Eve memory slot with the
  built-in file provider, holding a short list of durable facts about the owner (injuries, preferences,
  routines, people, standing instructions). Eve recalls the whole document before every turn and again
  after compaction, so facts reach sessions that never see the iMessage thread (workout analyses,
  `coach`, `deep`) and survive compaction verbatim. The model maintains it with `owner__save_memory` and
  `owner__remove_memory`; nothing is captured automatically.
  - **Scope.** `ownerMemoryScope` (`lib/owner.ts`) is `[issuer, principalId]` for user principals, so the
    owner's chat, workout and coding-session turns share one document even though `ownerAuth` keeps
    each trigger's own authenticator (Eve's `byPrincipal` keys on the authenticator and would split
    them). Service principals (reminder delivery) get no memory; `eve dev` uses one `local-dev` scope.
  - **Namespace.** `ownerMemoryNamespace` is Eve's `defaultNamespace` with the graph node pinned to
    root. The memory key is derived from namespace and scope only, and the file provider stores it at
    `eve/memory/file/<key>/MEMORY.md`, so root, `coach` and `deep` read the same document. Production
    keeps one namespace across deploys (project + environment); each preview branch gets its own.
    On Vercel without the project id or environment in system env, Eve's default would fall back to
    a form a preview could share with production, so the resolver returns `null` and memory is off
    (logged as `[owner-memory] Vercel project or environment unknown`).
  - **Read-only subagents.** `coach` and `deep` declare the same slot (subagents inherit nothing) and
    disable its tools with `tools/owner.ts` (`disableTool()`); recall is a lifecycle hook, so they still
    read it. Their instructions say they cannot change memories, despite the recall header naming the
    remove tool.
  - **Writes only from owner chat.** `guardedMemory` (`lib/memory.ts`) wraps the provider and offers
    the save and remove tools only when `isOwnerChat` holds: the turn resolves to a delivery channel
    (`isOwnerChat`, the gate `merge_pull_request` uses) or is `local-dev` (`canWriteMemory`). Workout debriefs
    and coding-session updates carry text the owner did not write, so they can read memory but have
    no tool to write it. Untrusted content inside a chat turn (a forwarded email, a web result) is
    guarded by the instructions only.
  - **Storage.** Private Vercel Blob, in the same store as the home target: on Vercel Eve finds
    `BLOB_STORE_ID` (OIDC) or `BLOB_READ_WRITE_TOKEN` itself, and writes use optimistic versioning.
    `eve dev` and evals use process-local in-memory storage. Eve fails the turn when recall throws;
    `guardedMemory` logs `[owner-memory] recall failed` and continues without memory instead (an
    aborted turn still throws), so a Blob outage, a missing store or a corrupt document costs recall,
    not replies. Saves and removes still fail into the tool result.
  - **Cost.** Recall is capped at 4,000 characters (about 1k tokens) and is one Blob read per turn per
    agent. Eve skips a recall identical to the copy already in context, so in the long-lived iMessage
    session the document sits in context once. Each save or remove appends a fresh copy and hides the
    old one, which breaks the prompt cache from the old copy onward; keep the list stable and short.
    Over-limit saves are rejected rather than evicting, so the model prunes stale entries.
- **Notion** (`lib/notion.ts`): one user-scoped Vercel Connect connection shared by root Adam,
  the coach and the deep worker, its auth wrapped in `signInFromOwnerDirectChat`
  (`lib/connection-auth.ts`). In the owner's direct chat the first Notion call parks the turn, the
  Photon channel's `authorization.required` handler texts the sign-in link, and the turn resumes
  after consent. Every other turn (group chat, debrief, coding update, briefing) gets the same
  grant through a getToken-only provider: a stored grant works as usual, and a missing or revoked
  one fails the call with `sign_in_needs_direct_chat`, so the model says Notion needs connecting
  instead of the turn waiting. Runs started by a trigger without the owner's identity (reminders
  today) fail with `principal_required`.
- **Workout coach** (`agent/subagents/coach/`): uses `openai/gpt-6.1-sol`, riz-mcp and the shared
  Notion connection, plus the vendored riz-mcp
  skill and `workout-debrief` skill. The model choice suits focused coaching; keeping raw workout
  data in the coach's context avoids dumping it into the user's chat.
- **Deep worker** (`agent/subagents/deep/`): uses `openai/gpt-6.1-sol`, Eve's default web/sandbox
  tools and the shared Notion connection. Root delegates heavy multi-step work to it as an Eve task,
  so luna acknowledges, keeps replying (new iMessages steer the turn without stopping the task),
  and relays the result. It cannot message or schedule, so right-to-silence stays with root. The
  built-in root-copy `agent` tool is disabled via `agent/tools/agent.ts`.
- **Coding sessions** (`agent/lib/devin.ts`, `agent/lib/coding-sessions.ts`): root Adam hands
  engineering work to Devin through the v3 REST API, so a missing capability ("block my calendar"
  with no calendar access) or a bug becomes a pull request against Adam's own repo without the owner
  re-briefing anyone. `lib/devin.ts` is the only file that knows Devin; the tools speak in
  `CodingSession`s, and `lib/coding-sessions.ts` owns the brief wrapper (open a PR, never merge, ask
  one short question when blocked, list manual steps such as env vars) and the single
  `codingSessionState` vocabulary (`working`, `needs_input`, `finished`, `asleep`, `stopped`, …)
  derived from Devin's `status` and `status_detail`. A finished or blocked Devin session still
  reports `status: "running"`, so the detail is what matters. Sessions are tagged `adam`, which is
  how `list_coding_sessions` finds them without any store of our own; the tag filter's query
  encoding is undocumented, so results are also filtered client-side. Devin has no idempotency key,
  so each create also carries a tag unique to the tool call and a replayed call returns the session
  it already made. Devin's messages reach the model as content to relay, never as instructions.
  Devin picks the repos from the brief (its `repos` field is only a hint that the docs say goes into
  the prompt), so Adam passes repos only when the owner named them, and a change can span several
  repos in one session with one pull request per repo. Every brief says where Adam's own code lives
  (`VERCEL_GIT_REPO_OWNER`/`VERCEL_GIT_REPO_SLUG`), so work on Adam lands in the right repo.
  `list_coding_repos` (Devin's `GET /repositories`) answers what Devin can work on. Adam holds no
  GitHub credentials of its own. Swapping Devin for another cloud coding agent is a rewrite of
  `lib/devin.ts` only.
- **Coding session updates** (`agent/channels/coding-sessions.ts`): Devin has no outbound webhooks,
  so Adam polls. Starting or messaging a session publishes a QStash watch tick to
  `/eve/v1/coding-sessions/watch`; each tick reads the session and its messages and publishes the
  next one. The tick carries all watch state (`notified`, the key of the last update sent, and a
  failure count), so there is no store.
  - **Pacing.** The interval follows the session's own idleness: 1 minute while it is busy, then 2,
    4 and 8 minutes. Watching ends when the session is asleep, stopped, halted, failed or ended,
    after 24 idle hours, after thirty failed checks in a row (about an hour of Devin outage), or on
    a permanent Devin API error. An update that failed to publish keeps the watch alive until it
    goes out.
  - **One watch per session.** Each tick lands on a wall-clock slot named in its QStash
    deduplication id, and the steps nest. A second watch on the same session, such as a restart
    from `message_coding_session` or a replayed tool call, collides with the first on a shared slot
    and is dropped, so tools can re-arm the watch freely. QStash deduplicates for only ten minutes,
    which covers one slot ahead but not the life of a state.
  - **Repeat suppression.** Updates are keyed by session, state and the newest message id, and a
    tick publishes one only when the key differs from `notified`. A new question, or a new finish
    after feedback (with or without a new Devin message), still gets through. For five minutes after
    the owner writes, Devin's status still describes the turn before it, so it is neither news nor a
    reason to stop watching; this keeps a just-woken session from reading as asleep.
  - **Notable states.** `needs_input`, `needs_approval`, `finished`, `halted` and `failed`. Halted
    and failed carry Devin's `status_detail` as the reason.
  - **Delivery.** The notify route delivers a `<coding_session_update>` into the home iMessage
    thread with `turnPolicy: "queue"`, acting as the owner with its own `coding-sessions`
    authenticator, the same way workout debriefs arrive, and root Adam applies right-to-silence.
    Devin's text and title are relayed as content, with anything resembling the wrapper tag stripped.
  - **Turns that never park.** An update turn's principal differs from the owner's own iMessages,
    so Eve queues the owner's replies behind it rather than letting them steer it. Nothing in an
    update turn may therefore wait on the owner. Tools that need the owner's confirmation refuse
    outside a chat turn (`isOwnerChat`), and `schedule_reminder` resolves the current turn's channel,
    then the session initiator's, then the home thread. A sign-in is the other way to wait: Eve holds
    a turn on one until the caller connects, the turn is cancelled or that same caller writes again,
    and documents no expiry. Eve parks only for an interactive provider (one with
    `startAuthorization`; `startScopedAuthorization` in `eve/dist/src/runtime/connections/scoped-authorization.js`
    is the only caller of `requestAuthorization` and returns early otherwise), and resolves an `auth`
    function per execution step from the current caller. `signInFromOwnerDirectChat` returns the
    interactive provider only in the owner's direct chat, so no other turn can open one, whichever
    trigger started it. Every user-scoped connection goes through it.
- **Merging** goes through Devin, whose own GitHub access opens the pull requests, so Adam holds no
  GitHub credentials. `merge_pull_request` is a workflow tool (`defineWorkflowTool`). A step
  refuses unless the current turn is the owner chatting (`isOwnerChat`). Another finds the coding session that opened the PR among Adam's tagged sessions; a PR no
  session of Adam's opened is refused, and a merged or closed one is reported, all without
  prompting. Otherwise it asks with `ctx.ask`, a plain-text confirmation naming the PR
  (`Merge owner/repo#n ("<session title>")? It gets squash-merged as it is now.`, options Merge and
  Cancel; `merge`/`1` or `cancel`/`2` in any case answers it, and any other message withdraws it as
  cancelled). On Merge a step messages the session to merge it as it is, without further commits,
  and to say why if GitHub refuses, then re-arms the watch; the outcome reaches the owner as a
  normal `<coding_session_update>`. It is `ctx.ask` and not Eve's `approval: always()` because an
  approval prompt on iMessage only reads `Approve <tool>?`, never the PR, and can only be answered
  by the exact requesting principal; a prompt parked in a background turn (debrief, coding update,
  reminder) could deadlock the thread, hence the owner-chat gate. The trade-off of merging through
  Devin is that nothing pins the exact commits the owner saw, and it wakes the session briefly.
- **Shared primitives**: `publishCallback`, `verifyCallbackSignature`, `hasValidCallbackSignature` and `parseJson` in `lib/qstash.ts`;
  `homeDelivery`, `isOwnerChat` and `isOwnerDirectChat` in `lib/delivery.ts`; `signInFromOwnerDirectChat`
  (interactive sign-in only in the owner's direct chat) in `lib/connection-auth.ts`; the single home pointer (delivery target and owner identity) in
  `lib/home-target.ts`; `ownerAuth`, `admitSender`, `ownerMemoryScope` and `ownerMemoryNamespace` in `lib/owner.ts`;
  the owner memory slot definition in `lib/owner-memory.ts`; `guardedMemory` (best-effort recall,
  write tools behind a caller check) in `lib/memory.ts`;
  `callRizMcpTool` in `lib/riz-mcp.ts`; `dailyCron` in `lib/cron.ts`; `claimDay` and `releaseDay` in
  `lib/daily-claim.ts`; `briefingMessage` and `briefingSections` in `lib/briefing.ts`; `notionConnection` in `lib/notion.ts`; and workout auth,
  message builders, sport skips, and the shared workout reference schema in `lib/workouts.ts`.
- **Tools** (`agent/tools/`): `schedule_reminder`, `cancel_reminder`, `list_reminders`, `generate_speech`,
  `transcribe_audio`, `start_coding_session`, `list_coding_sessions`, `get_coding_session`,
  `message_coding_session`, `stop_coding_session`, `list_coding_repos`, `merge_pull_request`
  (confirmed in chat, merged by Devin), `agent` (disables the built-in root-copy tool), plus the
  memory slot's `owner__save_memory` and `owner__remove_memory` and connection-provided tools.
- **Outbound media** (`agent/lib/outbound.ts`): one primitive for everything the model attaches. The
  model writes `![](url)`; `renderOutbound` fetches the url, keeps it only if its content type is in
  the allowlist (`image/*` plus common audio types), and hands the bytes to the channel. The Photon
  channel sends audio through its native voice-note path and everything else as an attachment, so
  generated speech gets iMessage's waveform UI instead of a downloadable file. An unreachable or
  disallowed url degrades to a raw link in the text. Model-chosen urls are untrusted: only `https` is
  fetched, every resolved address must be public (loopback, private, link-local, metadata and
  IPv4-embedding IPv6 ranges are refused, checked at connect time in `lib/public-fetch.ts`),
  redirects are followed manually for at most three hops with the same checks, and the body is
  streamed with a 10 MiB cap. Urls Adam published itself are read back through `lib/assets.ts`. `lib/speech.ts` (text → audio, via the AI
  Gateway) and `lib/assets.ts` (bytes → url, via a **private** Vercel Blob store) are the two seams
  behind `generate_speech`; a different TTS provider or blob store is a one-file change.
  Nothing Adam generates is ever world-readable: the url is only a handle, and `readAsset` is the
  one thing that can turn it back into bytes (authenticated, server-side). Hosting is also a
  handoff rather than storage — `renderOutbound` reports the urls it turned into files and the
  channel calls `releaseAssets` once iMessage has its own copy. Urls Adam did not publish are
  fetched plainly and never deleted.
- **Inbound media** (`agent/lib/inbound-media.ts`): one primitive that normalises every attachment
  the channel fetches, wrapped onto the Photon adapter's `fetchFile` by
  `withInboundMediaNormalization`. Providers reject iPhone `image/heic*` and Eve only inlines
  inbound images up to 3 MiB, so anything that isn't already a provider-safe type under that limit
  is decoded (HEIC via `heic-decode`), EXIF-rotated, resized inside 2048px, and re-encoded as JPEG.
  An undecodable fetched file throws, which Eve degrades to a model-visible note. `provider-safe-model.ts`
  repeats this check at the model boundary because durable history replays staged image bytes on every
  call; a raw image already staged before normalization shipped could otherwise wedge the session.
- **Inbound voice notes**: Photon's webhook omits the voice note's attachment GUID, so the photon
  channel resolves it with Spectrum's `getMessage` before Eve wires the download
  (`lib/photon-inbound.ts`). `transcribe_audio` reads the staged audio file from the sandbox and calls
  `lib/transcription.ts`, the STT seam. `lib/transcribable-audio.ts` uses ffmpeg to convert CAF and
  other unsupported types to 16 kHz mono WAV before sending audio through the AI Gateway.
- **Schedules** (`agent/schedules/`): periodic only — _never_ the reminder timer. A schedule has no
  inbound auth and no thread of its own, so it reaches the owner the way the channels do: resolve
  `homeDelivery()`, then deliver into the home thread with `turnPolicy: "queue"`, acting as the owner
  through `ownerAuth` with its own authenticator. Vercel Cron evaluates in UTC, so `dailyCron`
  (`lib/cron.ts`) turns a local time in `USER_TIMEZONE` into a UTC cron at build time; the zone's
  offset is baked in, so a zone with daylight saving drifts an hour after each change until the
  next deploy. Vercel Cron can fire a run twice, so a daily job claims its local date first with
  `claimDay` (`lib/daily-claim.ts`, a conditional write to one pointer per job, kept in private
  Vercel Blob by `lib/claim-store.ts`); a failed claim skips the run rather than risk sending it
  twice. If the work after a successful claim fails, `releaseDay` deletes the pointer (only if its
  etag is still the claim's) and the run rethrows, so Vercel records the cron run as failed and a
  re-run the same day is not skipped as already claimed.
  - **`briefing`** (7am local, once a day, Hobby-safe). Delivers a `<briefing>` trigger built by
    `lib/briefing.ts` from a list of section providers. Each section renders text or nothing, a
    failing section is left out rather than failing the briefing, and section text cannot close the
    wrapper tag (`stripWrapperTags` repeats until nothing is left to strip, so a tag split around
    another, `</bri</briefing>efing>`, is removed too). The only section today is the static guidance: check today's reminders with
    `list_reminders` and coding sessions waiting on the owner with `list_coding_sessions`, then send
    one short message if something is real and `stay_silent` otherwise, which is the expected
    outcome most mornings. It is a background turn, so it schedules, starts, messages and merges
    nothing and never waits on the owner. Later features (calendar and mail highlights, an overnight
    browser digest) add a section to `briefingSections` without touching the schedule.
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
│   ├── agent.ts               # gateway model: openai/gpt-6-luna
│   ├── instructions.md        # personality, right-to-silence, when to nudge
│   ├── memory/
│   │   └── owner.ts           # owner memory slot (file provider, private Blob)
│   ├── channels/
│   │   ├── photon.ts          # photonIMessageChannel: iMessage via Photon (Spectrum Cloud)
│   │   ├── reminders.ts       # defineChannel: POST /deliver → verify sig → receive(<delivery channel>,…)
│   │   ├── coding-sessions.ts # QStash watch ticks poll Devin; notable news goes to the home thread
│   │   └── workouts.ts        # Strava/Hevy webhooks and signed QStash callbacks
│   ├── connections/
│   │   ├── notion.ts
│   │   └── riz-mcp.ts
│   ├── subagents/
│   │   ├── coach/
│   │   │   ├── agent.ts
│   │   │   ├── instructions.md
│   │   │   ├── connections/
│   │   │   │   ├── notion.ts  # shared Notion connection config
│   │   │   │   └── riz-mcp.ts
│   │   │   ├── memory/owner.ts # same owner memory, recall only
│   │   │   ├── tools/owner.ts # disableTool(): no save/remove in the coach
│   │   │   └── skills/
│   │   │       ├── riz-mcp/   # vendored from nafisazizir/riz-mcp
│   │   │       └── workout-debrief/
│   │   └── deep/
│   │       ├── agent.ts
│   │       ├── instructions.md
│   │       ├── connections/
│   │       │   └── notion.ts  # shared Notion connection config
│   │       ├── memory/owner.ts # same owner memory, recall only
│   │       └── tools/owner.ts # disableTool(): no save/remove in the deep worker
│   ├── lib/
│   │   ├── env.ts             # single source of truth: parse/validate/sanitise env; derive callback URLs
│   │   ├── delivery.ts        # delivery registry, homeDelivery, and the owner-chat gates
│   │   ├── connection-auth.ts # signInFromOwnerDirectChat: no sign-in outside the owner's direct chat
│   │   ├── home-target.ts     # owner and the last direct chat they messaged from, in private Vercel Blob
│   │   ├── notion.ts          # shared Notion connection config
│   │   ├── owner.ts           # admitSender (only the owner gets in), ownerAuth, and the owner memory scope and namespace
│   │   ├── owner-memory.ts    # the owner memory slot definition shared by root, coach and deep
│   │   ├── memory.ts          # guardedMemory: best-effort recall, write tools only for allowed callers
│   │   ├── workouts.ts        # workout auth, messages, address, and shared ref schema
│   │   ├── riz-mcp.ts         # shared connection config and callRizMcpTool
│   │   ├── outbound.ts        # bubble splitting + `![](url)` → real attachments (image/* and audio)
│   │   ├── inbound-media.ts   # fetchFile wrapper: provider-safe JPEGs from HEIC/oversized images
│   │   ├── provider-safe-model.ts # model-boundary normalization for replayed inline images
│   │   ├── speech.ts          # text → audio bytes (AI Gateway speech model)
│   │   ├── transcription.ts   # audio → transcript (AI Gateway transcription model)
│   │   ├── transcribable-audio.ts # normalize audio formats with ffmpeg
│   │   ├── assets.ts          # bytes ↔ url (private Vercel Blob), dropped after delivery
│   │   ├── devin.ts           # Devin v3 REST client: create/get/list/message/archive sessions
│   │   ├── coding-sessions.ts # brief wrapper, state vocabulary, watch ticks, update messages
│   │   ├── pull-requests.ts   # PR url identity and the merge request to Devin (no deps: workflow-safe)
│   │   ├── briefing.ts        # morning briefing message from a list of section providers
│   │   ├── cron.ts            # dailyCron: a local time in a zone → a UTC cron expression
│   │   ├── daily-claim.ts     # claimDay/releaseDay: one run per job per local date, over a ClaimStore
│   │   ├── claim-store.ts     # the ClaimStore in private Vercel Blob
│   │   └── qstash.ts          # callback publishing, reminder APIs, signature verify
│   ├── tools/
│   │   ├── schedule_reminder.ts
│   │   ├── cancel_reminder.ts
│   │   ├── list_reminders.ts
│   │   ├── generate_speech.ts # speak text, upload, return the url the model embeds
│   │   ├── transcribe_audio.ts # transcribe a sandbox audio attachment
│   │   ├── start_coding_session.ts # brief Devin; it opens a PR per repo it changes
│   │   ├── list_coding_sessions.ts
│   │   ├── get_coding_session.ts # state, PRs, and the latest messages
│   │   ├── message_coding_session.ts # answer its question or pass on feedback
│   │   ├── stop_coding_session.ts # archive (sleep), still resumable
│   │   ├── list_coding_repos.ts # what Devin can work on (starting a session does not need it)
│   │   ├── merge_pull_request.ts # workflow tool: confirm in chat, then Devin merges
│   │   └── agent.ts           # disables the built-in root-copy agent tool
│   └── schedules/
│       └── briefing.ts        # 7am local: <briefing> into the home thread, silent unless something matters
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
- **Cross-session long-term memory** (durable facts about the owner that span sessions, subagents
  and surfaces) → the `owner` Eve memory slot (§4): a bounded, model-maintained document in private
  Vercel Blob, recalled before every turn of root, `coach` and `deep`, and preserved verbatim across
  compaction. It holds facts, not history.
- **The conversation itself** is still the one iMessage session, so `agent.ts` disables Eve's
  session timeout (`sessionTimeoutMs: false`; the default 30 days would start the thread over empty).

---

## 7. v1 scope & non-goals

**In:** iMessage round-trip · `schedule_reminder` + `reminders` delivery via QStash · a daily
morning `briefing` cron into the home thread that stays silent unless something matters · Strava/Hevy workout debriefs via the `coach` subagent · heavy-work delegation
to the `deep` subagent · right-to-silence
instructions · outbound image and audio attachments, with `generate_speech` for the occasional
voice note (text stays the default; see `agent/instructions.md`) · inbound voice-note transcription
with `transcribe_audio` · Devin coding sessions started, checked, messaged and stopped from chat,
with their questions, finished pull requests and failures texted back as they happen, and their
pull requests merged on the owner's say-so after a confirmation naming the PR · durable owner facts
remembered across sessions with the `owner` memory slot.

**Out (deferred):** Redis · semantic memory recall · multi-user · multi-channel · `inbox` and `finance`
subagents · email integration · inbound burst debouncing (low-risk single-user; add a Photon
`onMessage` buffer only if it bites).

### Environment variables

All env is parsed, validated, and sanitised in one place — `agent/lib/env.ts` (zod) — and consumed
from there, never via raw `process.env`. Derived values live there too, so the deliver URL is **not**
its own env var; it's computed from `BASE_URL` as `remindersDeliverUrl = \`${BASE_URL}/eve/v1/reminders/deliver\``.

```
USER_TIMEZONE=...                   # optional, IANA name, defaults to Australia/Brisbane; drives every time prompt
BASE_URL=...                        # app's public origin, e.g. https://adam.vercel.app (deliver URL derived in env.ts)
IMESSAGE_PROJECT_ID=...             # Photon project
IMESSAGE_PROJECT_SECRET=...
IMESSAGE_WEBHOOK_SECRET=...         # verify inbound Photon webhook
OWNER_IMESSAGE_HANDLES=...          # optional; the owner's E.164 numbers and Apple ID emails, comma-separated; when set, the only handles admitted
QSTASH_TOKEN=...                    # publish reminders
QSTASH_CURRENT_SIGNING_KEY=...      # verify callback signature
QSTASH_NEXT_SIGNING_KEY=...
QSTASH_URL=...                      # optional; QStash API origin for the region
RIZ_MCP_URL=...                     # riz-mcp server for Strava activity details and the coach
RIZ_MCP_JWT_SECRET=...              # signs the JWT riz-mcp expects
AI_GATEWAY_API_KEY=...              # or ANTHROPIC_API_KEY; also routes the speech model
BLOB_READ_WRITE_TOKEN=...           # optional; private Vercel Blob store for generated audio, the home delivery target and owner memory
TRANSCRIPTION_MODEL=...             # optional, defaults to microsoft/mai-transcribe-2
SPEECH_MODEL=...                    # optional, defaults to openai/tts-1
SPEECH_VOICE=...                    # optional, defaults to alloy
STRAVA_WEBHOOK_VERIFY_TOKEN=...     # Strava GET handshake
STRAVA_WEBHOOK_SUBSCRIPTION_ID=...  # optional; unset fails closed and ignores events
HEVY_WEBHOOK_SECRET=...             # Hevy Authorization header
NOTION_PLANS_DATA_SOURCE_ID=...     # coach's training plan data source
NOTION_WORKOUTS_DATA_SOURCE_ID=...  # coach's workout analyses data source
DEVIN_API_KEY=...                   # optional; Devin v3 key (cog_…), service user or personal access token
DEVIN_ORG_ID=...                    # optional; org-… from Devin Settings → Devin API
DEVIN_MAX_ACU_LIMIT=...             # optional; per-session spend cap in ACUs
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
- Set up the user-scoped Notion connector with `eve add connection/notion --skip-install`, attach it
  to the project, then ask Adam for something in Notion in a direct iMessage chat and follow the link it texts.
  Configure both Notion data source IDs in Adam's environment.
- Workout analyses and nudges require a connected private Vercel Blob store and are skipped until the
  user has texted Adam once after deploy; that chat becomes the remembered home target and owner.
- Owner memory lives in the same private Blob store, read by Eve from the store's own `BLOB_*`
  variables; no extra setup. Without a store, turns run without memory and saves fail. It also needs
  Vercel's system environment variables exposed (the default), or memory stays off.
- Adam answers only its owner (see "Only the owner" in §4). With the home pointer already holding
  the owner nothing needs setting. To text from another handle (a second number, the Apple ID
  email), or to run without a Blob store, list it in `OWNER_IMESSAGE_HANDLES`; the logs show the
  handle of every ignored message. List the recorded owner's handle too: adding aliases then keeps
  the recorded principal and its Notion grant, while a list that leaves it out locks that handle out.
- To replace the owner, in this order: set `OWNER_IMESSAGE_HANDLES` to the new owner's handles,
  delete `home-target.json`, then redeploy so no warm instance keeps the old owner cached. Deleting
  the pointer first opens a window in which any stranger's direct message claims ownership. Notion
  then has to be connected again, since grants follow the principal.
- If the logs show `the home pointer is unusable`, every message is being dropped: fix or delete
  `home-target.json` as above. Keep any new pointer field optional, or the existing pointer turns
  unusable on deploy.
- The coach is billed per token through AI Gateway.
- Refresh and verify the vendored coaching skill with `pnpm sync:riz-mcp-skill --from …` and
  `pnpm sync:riz-mcp-skill --check`.
- Coding sessions need `DEVIN_API_KEY` and `DEVIN_ORG_ID`. A service user needs permission to
  use, view and manage org sessions (`UseDevinSessions`, `ViewOrgSessions`, `ManageOrgSessions`);
  a personal access token acts as the owner and has them already. Without both, Adam still boots
  and only the coding tools fail. Briefs name Adam's own repo from Vercel's Git system env; without a Git
  connection that line is left out and Devin infers it. An org that restricts session
  tags must allow `adam` and the `adam-request-*` tags.
- A watched coding session costs one QStash message a minute while Devin is busy, backing off to
  one every eight minutes when idle, plus one per update. A session that never sleeps is capped at
  24 idle hours, about 250 messages; two such sessions would use most of the free tier.
- The `briefing` cron fires once a day at 7am in `USER_TIMEZONE` (`0 21 * * *` for the default
  Brisbane). Hobby runs it somewhere within that hour. It is skipped until the home target exists, and
  a change of `USER_TIMEZONE` moves it only after a redeploy. To try it with `eve dev`, POST to
  `/eve/v1/dev/schedules/briefing`.
- QStash free tier ≈ 500 msgs/day — fine for personal use; confirm current limits.

---

## 8. Roadmap

Ordered roughly by value. Each specialist is a **declared subagent** (`agent/subagents/<id>/`,
own instructions/tools/connections; inherits nothing from root).

Each item names its seam: the one file that knows the vendor, and what the rest of Adam talks to.
Settle the seam here before briefing a coding session, so a capability lands as a primitive rather
than a one-off tool, and a vendor swap stays a one-file change. Steps only the owner can do (vendor
plans, OAuth consent screens, logging in to accounts) are listed so a brief can name them.

1. **Google Workspace (`inbox`).** Gmail and Calendar across the owner's several Google accounts;
   triages mail, exercises right-to-silence, schedules follow-ups, and feeds `briefing` through
   a section in `lib/briefing.ts`.
   - **Seam.** `lib/google.ts` is the only file that knows Google. Tools speak in accounts keyed by
     email address and take an `account` argument or search all of them. Candidate backends: the
     Google APIs directly, or Google's `gws` CLI (multi-account, has a `gws mcp` mode; labelled not an
     officially supported Google product, pre-1.0).
   - **Auth.** One Google Cloud OAuth client the owner creates. In "Testing" status its refresh
     tokens expire after 7 days, so publish it (an unverified-app warning is fine for one user) and
     confirm tokens persist. Per-account refresh tokens live in private Vercel Blob, or in Vercel
     Connect if it covers Google.
   - **Safety.** Read-only scopes first. Sending mail and writing events are confirmed in chat with
     `ctx.ask`, as `merge_pull_request` is. Mail is untrusted input: bodies reach the model as
     content, never instructions, so nothing read from an email acts without that confirmation.
2. **Voice calls.** Call Adam like texting it, with the same context, and have it act mid-call.
   - **Line.** Photon's Spectrum voice provider adds inbound and outbound SIP calls to the iMessage
     line, with cookbooks for ElevenLabs, Retell, LiveKit and Twilio; that would make the call
     number the text number. The docs don't say which plan or line type includes voice — confirm
     with Photon first. Fallback: an Australian number (Twilio local ≈ US$3/month, ≈ 1¢/min
     inbound) so calls from the owner's phone stay domestic. FaceTime is not on offer.
   - **Front end.** A realtime voice agent (ElevenLabs, Retell or LiveKit) holds the conversation.
     Eve's built-in `twilioChannel` answers with `<Gather input="speech">`, one full agent turn per
     utterance, which is too slow to converse with.
   - **Seam.** The voice agent is a thin front end with one tool, `ask_adam(request)`, which
     delivers the request into the home iMessage session through a `calls` channel, the way
     `coding-sessions` delivers updates. Adam stays the only agent, so a call can do anything chat
     can because chat is what does it: "text me photos of that place" lands in iMessage mid-call.
     `lib/voice.ts` is the only file that knows the voice vendor. Open question: how Adam's answer
     returns to the call (Eve's HTTP session stream vs. a callback the `calls` channel resolves).
   - **After the call.** A `<call_ended>` trigger carrying the transcript summary enters the home
     session with `turnPolicy: "queue"`, and Adam calls `stay_silent`: the call joins chat history
     without a recap on the phone. At call start the voice agent needs a short briefing of recent
     context, which is the first real need for memory (item 4).
3. **A computer (`operator` subagent).** Read-only browsing of logged-in sites: X and LinkedIn
   notifications, research, an overnight digest.
   - **Seam.** A subagent with computer-use tools over a hosted browser that keeps logins
     (Browserbase, Steel, Kernel); `lib/browser.ts` is the only file that knows the vendor. The
     Vercel Sandbox stays for headless work. An overnight digest is a schedule that delegates to it,
     or a `briefing` section that does.
   - **Risk.** X and LinkedIn prohibit automated access, and LinkedIn bans accounts for it. Keep it
     read-only, low-volume and human-paced, or use a secondary account. Least certain value and
     most risk of the three, so it comes last.
4. **Cross-session memory.** Built: the `owner` memory slot (§4) with the built-in file provider,
   scoped to the owner's identity across every trigger that acts as them, shared read-only with
   `coach` and `deep`. Remaining: give the voice front end (item 2) the same facts at call start, and
   move to Supermemory or Upstash only if a short document stops being enough and semantic recall is
   needed.
5. **Extend `coach`.** Post-workout debriefs are built with riz-mcp and Notion. Done: pre-session
   reminders, about 15 minutes before the next workout, scheduled by root through `schedule_reminder` when the
   debrief carries a concrete next-session time (the plan has no clock times, so otherwise nothing is scheduled).
6. **Multi-channel.** iMessage (`photon`) is the primary surface; WhatsApp and friends are a file in `channels/`
   plus an entry in `lib/delivery.ts`. The trigger model and reminder loop are channel-agnostic
   (`receive` takes any channel; reminder payloads carry `{ channel, target }`).
7. **`finance`.** Spend tracking, anomaly surfacing, weekly summary (cron).
8. **Orchestration.** Enable the experimental `Workflow` tool to fan out subagents (e.g. a weekly
   "life review" running `coach` + `finance` in parallel and merging).
9. **External event triggers.** Strava/Hevy workout webhooks are built in `workouts`; new-mail
   triggers follow `inbox` (item 1).
10. **Multi-user hardening.** Per-user Connect OAuth for connections, per-user reminder/memory keys,
    auth on inbound routes, and an identity layer (Redis or Postgres) mapping an iMessage handle and
    a WhatsApp number to the same logical user. `admitSender` becomes a lookup of the sender in
    that layer instead of a single owner.

---

## 9. Glossary (mental model)

- **Trigger** — anything that starts a session: inbound message, reminder callback, cron, webhook.
- **Session** — one durable conversation/task in Eve; owns its history; survives redeploys.
- **Turn** — one user message + all work it triggers until a response.
- **Channel** — an HTTP/messaging entrypoint (`agent/channels/`); owns inbound parsing + delivery.
- **`receive(channel, …)`** — start a session on a channel without an inbound message (proactive send).
- **Connection** — an external MCP/OpenAPI server surfaced to the model as tools.
- **Subagent** — a child agent for a focused role, with its own tools/connections.
- **Right to silence** — the agent's explicit option to do nothing on a trigger. Exercised by calling
  the `stay_silent` tool, never a blank reply (Eve treats that as a model failure).

---

## 10. References

- Eve docs: `node_modules/eve/docs/` (bundled with the `eve` package).
- Poke (Interaction Company) — the proactive iMessage assistant Adam reimagines for OSS.
- OpenPoke — open reconstruction of Poke's interaction/execution agent split.
- caltext (pontusab) — prior-art app on a similar stack (Hono/Chat SDK/Sendblue/Upstash/Workflow);
  read for integration patterns, not forked.
