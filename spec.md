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
| External tools (riz-mcp, Notion)                    | **Connections** (`defineMcpClientConnection` / OpenAPI)                                                                                      |
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
list_reminders ──> shared reminder list (private Blob JSON; every session reads the same one)
cancel_reminder ─> QStash messages API, then drops the list entry
                  (cancelling one that already fired or was cancelled returns
                   { cancelled: false, reason } instead of failing)
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
   Gmail push       ──▶│ new mail (mail channel, Pub/Sub)       │
   Phone call       ──▶│ voice calls (calls channel)            │
                       └────────────────────────────────────────┘
                                         │
                 every trigger's payload becomes the session's first message
```

- **Channels** (`agent/channels/`): `photon` (reactive UI + delivery), plus
  `reminders` (custom channel; QStash callback endpoint that hands off to whichever delivery channel
  the reminder was scheduled from, via `receive` (or to the home thread whenever one is stored, so a reminder set from a group chat never posts in the group); it answers 500 when the hand-off to the delivery
  channel fails so QStash retries (a later failure posting to the phone is not retried), and
  `schedule_reminder` publishes with a deduplication id derived from the session, turn, message and the model-given time (`at` with `leadMinutes`, or `delaySeconds`)
  (`lib/replay-key.ts`), so a re-run step does not schedule a second copy within QStash's
  ten-minute window; the owner's upcoming reminders live in one private Blob document shared by every session
  (`lib/reminder-list.ts` over `lib/reminder-list-store.ts`, conditional writes with retry): `schedule_reminder` appends,
  `cancel_reminder` and the delivery here remove, `list_reminders` prunes past entries. QStash stays the source of truth for
  firing, so a Blob failure never blocks scheduling and listing then says it could not read the list); the hand-off acts as the owner read from the home pointer at fire time
  (`reminderAuth`, authenticator `reminders`, `turnPolicy: "queue"`, the same shape as coding-session
  updates and the briefing), and falls back to a `service` principal only when no owner is stored,
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
    them). Service principals (a reminder fired with no owner stored) get no memory; `eve dev` uses one `local-dev` scope.
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
    the save and remove tools only when `canWriteMemory` holds: the turn is the owner's chat
    (`isOwnerChat`, the gate `merge_pull_request` uses) or is `local-dev`. Workout debriefs
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
  grant through a getToken-only provider: a stored grant works as usual, and one that is missing or
  that Connect reports revoked fails the call with `sign_in_needs_direct_chat`, so the model says
  Notion needs connecting instead of the turn waiting. A token Notion itself rejects surfaces as the
  MCP client's own authorization error, which cannot park either. Only a reminder fired before any owner is stored runs without the
  owner's identity and fails with `principal_required`.
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
- **Google Workspace** (`agent/lib/google.ts`): Gmail and Calendar across the owner's several Google
  accounts: reads, email drafts (never sending) and confirmed event writes, on root Adam (no `inbox` subagent yet). Vercel Connect owns Google sign-in,
  the refresh token and refresh; small typed tools call the Gmail and Calendar REST APIs with `fetch`
  (no SDK, no `gws`), and the access token stays in the tool process, never in the model's sandbox or
  history. `lib/google.ts` is the only file that knows Google (token requests, Gmail and Calendar
  endpoints, MIME and RFC 2047 decoding); tools speak in account names, `EmailSummary`/`Email` and
  `CalendarEvent`. Its `googleWorkspace({ connector, accounts, connect, fetch })` factory is what
  unit tests drive with a fake Connect, a fake account store and `fetch`. Every call takes the owner principal (`ownerPrincipal` in
  `lib/owner.ts` from the turn's auth, or `home.owner` outside a turn), so it works the same from a
  chat, the briefing or a channel route.
  - **Accounts.** One Connect connector (`GOOGLE_CONNECTOR`) serves any number of Google accounts.
    Connect keys a grant by connector and subject, so each account is its own subject under the
    owner: `googleSubject(owner, label)` is `{ type: "user", id: "<principalId>/google/<label>",
    issuer }`, and connecting a second account never replaces the first. Each token is requested
    with `openid`, `email`, `gmail.readonly`, `gmail.compose`, `calendar.readonly` and
    `calendar.events`; an account's address comes from
    OpenID userinfo with its own token and is cached for a day by subject in `secretCache` (sealed,
    in Runtime Cache). Connecting a name again or disconnecting it forgets that address, the
    subject's shared access token and Connect's in-process token (`deleteTokenCacheEntry`). The old
    grant still answers until the owner finishes consent, so a read in between can cache the old
    account again; `list_google_accounts`, which the owner's check after a connect goes through,
    therefore asks Connect for a fresh token (`forceRefresh`) and Google for the address past every
    cache, and a name reconnected to another Google account shows its new address. Tools name an
    account by its label or its address.
  - **Account list.** The labels (and when each was added) are the one thing Adam stores for Google:
    `lib/google-accounts.ts` (`googleAccountRegistry`: list, add, remove, plus `normalizeAccountLabel`)
    over a `GoogleAccountStore`, which `lib/google-accounts-store.ts` keeps as `google-accounts.json`
    in private Blob with conditional writes (`putConditional`, retried on a conflict). It is written
    only when a new name is connected or an account is disconnected. Reads go through
    `secretCache`, shared by every instance in the region, refreshed on each connect and disconnect
    and expiring after an hour (which only bounds a missed refresh), so the store is read about 24
    times a day at most, whatever the mail traffic; a name the cached list misses is
    looked up once more against the store, since another instance may have just added it. A read
    that misses the cache backfills it only if no write has cached a newer list meanwhile. A
    corrupt document fails the Google tools loudly rather than reading as empty. Besides the list,
    the only Google state Adam keeps is each mailbox's history cursor and recently delivered ids for
    new-mail triggers, and access tokens live briefly, sealed, in Runtime Cache.
  - **Consent.** `connect_google_account(account)` (the owner's direct chat only, through
    `ownerLinkRefusal` in `lib/connection-auth.ts` on `isOwnerDirectChat`: in a group anyone could
    open the link first and connect their own account as the owner's) takes the owner's own name for
    the account ("connect my work gmail" → `work`), normalised to lowercase letters, digits and
    dashes. A new name is added to the list first, so the grant the link creates is never one Adam
    cannot see; then it calls Connect's `startAuthorization` for that name's subject with the same
    scopes and returns the URL. If Connect gives no link, a name added for it is removed again. The owner picks the Google account on Google's screen. The same
    name again reconnects that account under the same subject. Connect runs the Google OAuth flow
    (its Google service adds `access_type=offline` and `prompt=consent`), stores the grant and
    refreshes it. Adam gets no callback; a name stays `needs_connecting` in `list_google_accounts`
    until its grant exists, and the owner says when they are done.
  - **Disconnect.** `disconnect_google_account(account)` is a workflow tool like
    `merge_pull_request`: the owner chatting only (`ownerChatRefusal` in `lib/delivery.ts`), then a
    `ctx.ask` confirmation naming the account and address. It revokes the grant with Connect's
    `revokeToken` first and only then removes the name, so a failed revoke leaves the account listed
    and says so, and the owner can retry instead of believing access is gone. A name that never
    signed in (Connect has no token for it) is simply removed. A revoke that worked followed by a
    list write that failed is reported as disconnected with a warning (the name shows as needing
    connecting until a second disconnect removes it). With new-mail triggers on, it first stops the
    account's Gmail watch (`users.stop`, while the token still works), and only once the revoke
    worked drops the mailbox's cursor and checkpoint (`stopWatchingMailbox` and
    `forgetMailbox` in `lib/mail-watch.ts`); a failed revoke restarts the watch, so heads-ups
    continue for an account that is still connected. A stop that fails is logged and the watch
    lapses within seven days; pushes for an address no longer on the list are acknowledged and
    ignored. A mail run checks its account is still listed before it writes any state, so a run
    already queued cannot recreate the state of an account just removed.
  - **Known limits.** Another warm instance may still hold a disconnected account's last access
    token in Connect's in-process cache, but stops listing it as soon as the shared list is
    refreshed (only owner turns read by name, and a revoked grant cannot refresh). A sign-in link
    left unused and opened after its name was disconnected still creates a grant for that subject;
    Adam cannot see it, and it returns if the name is added again.
  - **Background turns never sign in.** Tokens come from `@vercel/connect`'s `getToken`, which never
    starts a sign-in: a missing or revoked grant (`user_authorization_required` / `no_token`) becomes
    `GoogleNeedsConnectingError` for that account, so the briefing or a mail trigger reports it and
    the owner asks for a link in the direct chat (the same rule as Notion, #36).
  - **Reads.** `search_email` (Gmail `q` syntax) and `list_events` fan out over every account
    unless one is named, and return per-account `errors` (`needsConnecting` marks the ones that need
    a link) beside the results, so one broken account never hides the rest. `list_events` reads every calendar the owner shows (or only primaries),
    expands recurring events, and reports a failing shared calendar under `errors` while keeping the rest. Both follow page tokens up to a
    bound and return `truncated` when more matched than they returned. All-day events carry an
    inclusive last day (Google's end date is exclusive) and sort at the start of their local day in
    `USER_TIMEZONE` (`startOfLocalDay` in `lib/zoned-time.ts`). A grant missing a scope (Google's 403
    insufficient scopes) is reported as needing connecting. `read_email` prefers `text/plain`,
    falls back to HTML as text, trims quoted replies, caps the body at 8k characters and lists
    attachments without fetching them.
  - **Writes.** Consent and every token use one scope set, so an account connected before the
    write scopes fails a write with Google's insufficient-scopes 403, reported as needing
    connecting, and reconnecting that name once fixes it. Gmail has no draft-only scope:
    `gmail.compose` also allows sending, so "never sends" holds because Adam has no send tool.
    - `draft_email` (owner chatting only, `ownerChatRefusal`, no `ctx.ask`: a draft sends
      nothing, the owner reviews and sends it from Gmail) builds RFC 5322 with `composeEmail`
      (`lib/mime.ts`: RFC 2047 encoded words, line breaks stripped from header values so mail text
      cannot add a header) and posts it to `drafts`. A reply (`replyTo`, an email id) reads the
      original's `Message-ID`, `References`, `Subject` and `Reply-To`/`From`, keeps its thread and
      subject and defaults `to` to its sender. It returns a link to that account's drafts.
    - `create_event` and `update_event` are workflow tools like `disconnect_google_account`: the
      owner chatting only, then a `ctx.ask` confirmation naming the time and anyone invited or
      notified. Creates go on the account's primary calendar, with an optional Meet link. Updates
      take the `calendarId` and id from `list_events` (events now carry `calendarId`), patch what
      changed, and merge added and removed attendees into the current list, keeping responses.
      `sendUpdates` is `all` when the event has attendees, so Google emails them; otherwise `none`.
      An all-day end is the inclusive last day in the domain and exclusive on the wire.
    - A create is not retried after a 5xx, since the first attempt may have landed and a retry
      would duplicate a draft or an invite; a 429, a 401 and reads still are.
  - **Tokens.** Connect bills per token request and its SDK caches only per instance, so each
    account's access token is kept in Vercel Runtime Cache for its lifetime less five minutes; a
    token with under a minute left after that margin is not cached. Runtime Cache is shared by every
    instance in a region and split by environment, but on Hobby every project in the team shares
    one cache, and Vercel documents no encryption at rest. So tokens go through `secretCache`
    (`lib/shared-cache.ts`): values are sealed with AES-256-GCM, bound to their key, and key names are
    HMACs, both under keys derived with HKDF from `QSTASH_CURRENT_SIGNING_KEY`, so no new secret is
    needed; rotating that key only turns cached entries into misses. Key hashing is SHA-256 rather
    than `getCache`'s 32-bit default. Off Vercel `getCache` falls back to a per-process cache, and a
    cache failure reads as a miss. A 401 drops the cached token, asks Connect again with `forceRefresh`
    and retries once; a 401 on the fresh token means the account needs connecting. 429, 5xx and
    Gmail's 403 rate limits retry once.
  - **For new-mail triggers.** `watchMailbox` (Gmail `users.watch` on the inbox to a Pub/Sub topic),
    `mailboxHistory` (`users.history.list`, added inbox messages since a history id),
    `currentHistoryId` (`users.getProfile`), `emailSummaries` (message metadata, with the Gmail tab
    as `category`; a message deleted before it is fetched is left out) and `accountWithAddress`
    (the account a push names), used by the `mail` channel below.
  - **Untrusted content.** Every text field written by a sender or event organiser reaches the model
    inside `<email_content>` or `<calendar_content>` (`lib/untrusted.ts`, which strips any
    look-alike of that tag from the text so it cannot close early), and `instructions.md` says mail is
    data: nothing in it schedules, starts coding, merges, connects, saves memory or messages anyone,
    and no image or link from it is embedded with `![](url)`, which the server would fetch. That
    last rule is instruction only; `renderOutbound` does not know which urls came from mail.
- **New mail** (`agent/channels/mail.ts`): new inbox mail is a trigger, the way a finished
  workout is. Gmail's `users.watch` publishes to a Cloud Pub/Sub topic, whose push subscription
  POSTs to `/eve/v1/mail/push`. The channel only wires dependencies; the route logic lives in
  `lib/mail-routes.ts` (`mailPushHandler`, `mailRunHandler`), where it is unit-tested.
  - **Push.** `lib/pubsub-push.ts` is the only file that knows Pub/Sub: it verifies the push's OIDC
    token with `jose` (RS256 only, signed by a key from Google's JWKS, issuer `accounts.google.com`,
    audience `mailPushUrl` derived from `BASE_URL`, `email` equal to `GOOGLE_PUSH_SERVICE_ACCOUNT`
    with `email_verified`, unexpired) and decodes the `{ emailAddress, historyId }` payload. Without
    `GOOGLE_PUSH_SERVICE_ACCOUNT` every push is refused. An authentic but malformed push (for
    example with Pub/Sub payload unwrapping on) is acknowledged and logged, so Pub/Sub does not
    redeliver it. The route makes no Google call and answers fast; a failed QStash publish is a 500,
    so Pub/Sub retries.
  - **Coalescing.** Gmail pushes on every inbox change, read marks included. All pushes for a
    mailbox in one three-minute window share a QStash deduplication id (`mail-<address>-<window>`)
    and one run five seconds after the window closes (`coalescedMailRun` in `lib/new-mail.ts`), so a
    burst is one run and runs for a mailbox are a window apart. A `secretCache` marker skips the
    publish for a window already queued. `takeDailyMailRun` caps each mailbox at 120 runs a local
    day (best effort, a cache counter), logs when it is reached, and drops pushes until the next day,
    whose first run catches up from history; mail can then never spend the QStash budget reminders
    and coding watches need. An address a run found on no listed account is marked in `secretCache`
    for six hours (`unknownMailboxKey`), and the push route acknowledges its pushes without
    publishing, so a watch that outlived its account (a failed `users.stop`) costs one QStash message
    per six hours, not one per window.
  - **Process.** The signed callback maps the address to an account with `accountWithAddress` as
    the home owner (a transient lookup failure throws, so it is a 500 and QStash retries, rather
    than "unknown mailbox"). `processMailbox` lists inbox messages added since the cursor (up to five
    pages, the newest 30 ids; when history has more pages it logs that and reads the newest unread
    inbox mail instead), and fetches their summaries. `mightMatter` keeps unread mail in Primary (or
    with no category), and Updates or Forums mail only when Gmail marks it important; Promotions and
    Social never trigger. The newest ten that remain become one `<new_email>` trigger
    (`newEmailMessage`; each field is stripped of both `email_content` and `new_email` look-alikes
    in one looped pass, `untrusted(…, ["new_email"])`, so a sender cannot rebuild one tag out of the
    other) delivered to the home thread as the owner (`mailAuth`, authenticator `mail`,
    `turnPolicy: "queue"`), where root decides to text or `stay_silent`. A history id too old to
    replay (Gmail's 404) resets to the profile's current one and skips; a mailbox with no stored
    state starts from its current history id.
  - **One mailbox per state.** History ids belong to one mailbox, so the Blob state and the cursor
    record the address they were taken from (the pushed `emailAddress`), and a run or a watch
    renewal treats state recorded for another address as none: it starts from the new mailbox's
    current history id with an empty `delivered`. A name reconnected to another Google account can
    therefore never read from (or stall behind) the old mailbox's history id. Before writing any
    state a run checks that its account is still listed, so a run queued before a disconnect cannot
    recreate the state just removed.
  - **State, and the Blob budget.** The cursor every run reads is a `secretCache` entry
    (`{ historyId, emailAddress, checkpointedAt, openClaim }`). Private Blob (`mailboxes/<account>.json` through
    `lib/mailbox-state-store.ts`, conditional writes) is read only on a cache miss, when a run has
    noteworthy mail to claim, when a claim is open, or when a checkpoint is due, and written only to
    claim mail and as a checkpoint at most every six hours. A quiet run touches no Blob at all. On a
    cache miss the run replays from the Blob checkpoint; at worst it re-reads a few hours of history.
  - **Exactly once.** The Blob document keeps `delivered` (the newest 200 ids ever claimed) and a
    `claim`: `{ ids, claimId, claimedAt }`, where the claim id is the QStash `Upstash-Message-Id`,
    stable across retries of one run. A run claims its mail (adds it to `delivered` and takes the
    lease) in one conditional write before delivering, then sets a "delivered" marker for its claim
    id in the cache. Another run skips mail already in `delivered`; on a live lease (under two
    minutes) it answers 409 so QStash retries after the owner finishes; it takes over an expired
    lease that never reported delivered only within six hours, and never on a cold cache, where the
    marker is likely gone too (a missed heads-up beats a double one). A QStash retry of the same run
    owns its claim and resends it if delivery failed. A lost conditional write re-reads and decides
    again up to three times, then answers 409 so QStash retries. The one remaining double-send is a
    retry after a successful delivery whose response was lost, on a cache that lost the marker.
    An account that needs connecting is logged and skipped, never signed in.
  - **Watch renewal** is the `mail-watch` schedule (below), which renews every watch. A started
    watch leaves a `secretCache` marker that lives until a day before the watch expires, and
    `list_google_accounts` starts a watch only for a connected account without one
    (`watchMailboxes` in `lib/mail-watch.ts`), so an account the owner just (re)connected does not
    wait for 6am and an ordinary listing costs no Gmail or Blob call. The address a watch records
    comes from the mailbox profile, which reads whatever account the token now belongs to.
    Reconnecting an existing name first stops its watch (`users.stop`, while the old token still
    works) and drops the marker, so the listing after consent watches the new mailbox.
- **Calls** (`agent/channels/calls.ts`, `agent/lib/calls.ts`, `agent/lib/voice.ts`): the owner
  phones Adam's own number (a Twilio local number imported into ElevenLabs), which reaches one
  ElevenLabs Agents voice agent. The voice agent is a thin front end that holds the conversation
  and has one webhook tool, `ask_adam(request)`; Adam stays the only agent, so a call
  reaches the same context and tools as chat, except the few that only the owner's own chat may
  trigger (see "What a forged caller can and can't do" below). Only two files know ElevenLabs:
  `lib/voice.ts` at call time (signature and secret checks, payload parsing into neutral
  `CallStart`, `CallRequest` and `CallEnded`, each carrying the caller's E.164 number or null when
  withheld, and the response shapes), and `lib/voice-agent.ts` at deploy time (the agent's whole
  configuration and the sync below). Retell, or a voice line on Photon, stays a swap of those two;
  WhatsApp calling would be a transport added there, not a change to the routes.
  - **The agent is code.** `syncVoiceAgent` (`lib/voice-agent.ts`) pushes everything the voice
    agent is from this repo through the ElevenLabs API: a workspace secret holding
    `CALLS_TOOL_SECRET`, the `ask_adam` webhook tool (`askAdamTool`), the workspace post-call
    webhook, the agent itself (`voiceAgentConfig`: prompt `{{call_briefing}}`, first message
    `{{greeting}}`, the voice LLM, `end_call`, signed URLs only, the initiation webhook with fetching
    initiation data on, the post-call webhook with transcripts only, and `ELEVENLABS_VOICE_ID` when
    set) and the assignment of `CALLS_PHONE_NUMBER` to the agent. The owner imports the number into
    ElevenLabs once with Twilio's SID and token, so Adam never holds Twilio credentials; a number
    not imported yet is only logged. The ids it created live in
    private Blob (`voice-agent.json`, `lib/voice-agent-store.ts`), so a rename in the dashboard
    never makes a second agent and anything deleted there is created again. Each run updates in
    place and saves every new id before the next step, so a run that fails halfway is finished by
    the next. A workspace webhook's url can't change and its HMAC secret is shown only at creation,
    so a new `BASE_URL` makes a new post-call webhook, points the agent at it and then deletes the
    old one; the secret is kept in the same Blob record, where the `ended` route reads it, so there
    is no signing secret to copy by hand. `pnpm build` runs `scripts/sync-voice-agent.ts` after
    `eve build`; it acts only on a production build (a preview would repoint the one agent at a
    preview URL), skips without `ELEVENLABS_API_KEY` or `CALLS_TOOL_SECRET`, and logs a failure
    without failing the deploy, so ElevenLabs can't block one. `pnpm sync:voice-agent` runs it on
    demand against whatever environment it is given, and fails loudly. Changes made in the
    dashboard to anything the sync owns are overwritten on the next deploy.
  - **Start** (`/eve/v1/calls/start`, the conversation initiation webhook) returns dynamic
    variables only: `call_briefing` (persona, the owner's local time, and the rule to use `ask_adam`
    for anything beyond small talk), `greeting` and `local_time`. No private data goes to the vendor; the context lives in the
    owner's thread, one `ask_adam` away. The agent's system prompt in the dashboard is just
    `{{call_briefing}}`, so the persona is versioned here. A caller who is not the owner gets a
    briefing that declines and ends the call. An admitted call also queues a `<call_started>` into
    the home thread, and Adam texts one short line ("📞 call started"), never `stay_silent`, so the
    owner notices a call they did not make once the thread is free.
  - **Which thread.** Every call delivery goes where `homeDelivery()` sends it: the owner's iMessage
    thread, so photos and links Adam texts mid-call land there, and the call joins that history.
  - **Ask** (`/eve/v1/calls/ask`, the `ask_adam` tool) delivers a `<call_request id="nonce">` into
    that thread with `turnPolicy: "queue"`, acting as the owner with a `calls` authenticator
    (attributes `call: "live"` and `reply_by`, the route's deadline), and taps that session's event
    stream. The `Session` handle comes back from `deliver`, and the read starts 1000 events before
    the tail, since the handle only exists after the send and an idle session may already have
    started the turn. The scan (`scanCallReply`, a pure function over stream events) finds the
    `message.received` carrying the nonce, takes its `turnId`, and resolves on that turn's first
    `actions.requested` call to `reply_to_call({ speech })`; the speech is the webhook's answer, so
    the caller hears Adam before the turn finishes. The same turn then texts anything better read
    (photos, links) as its normal reply, or calls `stay_silent`. If the turn ends without speaking,
    parks on the owner (`turn.waiting` on input), fails, or misses the 25 s deadline (the ElevenLabs
    tool waits 30), the caller hears a fixed line; on a timeout the route also queues a
    `<call_missed>` so Adam texts the answer instead. `reply_to_call` refuses outside a live call
    turn and never ends the turn; a request turn that only starts after `reply_by` (it queued behind
    a busy or parked thread) is not live, so a late reply says nothing was spoken and Adam texts.
    Adam calls `reply_to_call` only once the turn's other tools have returned.
  - **Ended** (`/eve/v1/calls/ended`, the post-call webhook) verifies the `ElevenLabs-Signature`
    HMAC (`t=<unix>,v0=<hex HMAC-SHA256 of "t.body">`, 30-minute tolerance) with the secret the sync
    stored (`postCallWebhookSecret`) and delivers a
    `<call_ended>` with the summary and the end of the transcript into the home thread with
    `turnPolicy: "queue"` and `call: "after"`. The caller comes from the `system__caller_id`
    variable, as in start and ask, falling back to `metadata.phone_call`. Adam calls
    `stay_silent`, so the call joins the history without a recap. ElevenLabs retries, and a signed
    payload stays valid for 30 minutes, so each conversation id is claimed once (`claimOnce` over
    the Blob `ClaimStore`, released again if delivery fails). Look-alike tags of every call wrapper
    are stripped from relayed call text with `stripWrapperTags`.
  - **Only the owner.** `start` and `ask` share a secret header (`x-calls-secret`, compared in
    constant time). The caller must be a number that may text Adam over iMessage: `isOwnerCaller`
    runs `admitSender` from `lib/owner.ts` on it, so a set `OWNER_IMESSAGE_HANDLES` overrules the
    recorded owner exactly as in chat, and a call never claims an unknown owner. `start` declines
    anyone else, and `ask` and `ended` check again, so a dashboard preview or web widget with no
    caller id is refused.
  - **What a forged caller can and can't do.** A phone line's caller ID is cheap to fake from VoIP,
    and Australia has no STIR/SHAKEN, so the owner's number is the only gate; the owner chose that
    trade-off over a spoken passcode.
    - **Refused on every call turn** (`isCallTurn`): `start_coding_session`,
      `message_coding_session` and `stop_coding_session` (Devin works in the owner's GitHub org)
      and `cancel_reminder`; `merge_pull_request`, `disconnect_google_account` and memory writes,
      through the owner-chat gate (`isOwnerChat` is false for a `calls` auth); and
      `connect_google_account`, through the direct-chat gate. These stay refused even from the
      owner's real phone, since what was said reaches Adam paraphrased by the voice agent. Adam texts a
      one-line confirmation instead and acts on the owner's reply in chat. A call can never start a
      sign-in: like every turn outside the owner's direct chat it gets the token-only providers
      (`lib/connection-auth.ts`). Nothing in a call turn may wait on the owner.
    - **Allowed, so open to anyone who fakes the number.** A call turn acts as the owner's principal, so it can
      read the thread's history, owner memory, Gmail and Calendar, Notion through an existing
      grant and the owner's training data through riz-mcp, write Notion pages through that grant,
      and schedule reminders, which only ever land in the owner's own thread. A spoken passcode
      checked server-side in `ask` would close this if it is ever needed.
    - **Always.** The `<call_started>` text tells the owner a call is happening as soon as the
      thread is free; it queues like every call delivery, so it waits behind a running or parked
      turn.
- **Shared primitives**: `publishCallback`, `verifyCallbackSignature`, `hasValidCallbackSignature` and `parseJson` in `lib/qstash.ts`;
  `homeDelivery`, `isOwnerChat`, `isOwnerDirectChat` and `ownerChatRefusal` in `lib/delivery.ts`;
  `googleAccountRegistry` in `lib/google-accounts.ts`; `signInFromOwnerDirectChat`
  (interactive sign-in only in the owner's direct chat) and `ownerLinkRefusal` (the same rule for a
  link a tool hands out) in `lib/connection-auth.ts`; the single home pointer (delivery target and owner identity) in
  `lib/home-target.ts`; `ownerAuth`, `ownerPrincipal`, `admitSender`, `ownerMemoryScope` and `ownerMemoryNamespace` in `lib/owner.ts`;
  `untrusted`/`stripWrapperTags` in `lib/untrusted.ts`;
  the owner memory slot definition in `lib/owner-memory.ts`; `guardedMemory` (best-effort recall,
  write tools behind a caller check) in `lib/memory.ts`;
  `callRizMcpTool` in `lib/riz-mcp.ts`; `dailyCron` in `lib/cron.ts`; `claimDay`, `claimOnce` and `releaseDay` in
  `lib/daily-claim.ts`; `briefingMessage` and `briefingSections` in `lib/briefing.ts`; `sharedCache`, `sealedCache` and `secretCache` (Vercel Runtime Cache, best effort; sealed and HMAC-named for anything another project must not read) in `lib/shared-cache.ts`; `watchMailboxes` and `stopWatchingMailbox` in `lib/mail-watch.ts`; `notionConnection` in `lib/notion.ts`; and workout auth,
  message builders, sport skips, and the shared workout reference schema in `lib/workouts.ts`.
- **Tools** (`agent/tools/`): `schedule_reminder`, `cancel_reminder`, `list_reminders`, `generate_speech`,
  `transcribe_audio`, `start_coding_session`, `list_coding_sessions`, `get_coding_session`,
  `message_coding_session`, `stop_coding_session`, `list_coding_repos`, `merge_pull_request`
  (confirmed in chat, merged by Devin), `connect_google_account`, `disconnect_google_account` (confirmed
  in chat), `list_google_accounts`,
  `search_email`, `read_email`, `list_events`, `draft_email`, `create_event` and `update_event`
  (confirmed in chat), `reply_to_call` (speak on the live call), `agent`
  (disables the built-in root-copy tool), plus the
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
  - **`mail-watch`** (6am local, once a day). Gmail stops pushing to the topic seven days after a
    watch, so this renews `watchMailbox` on the inbox for every account on the account list, as
    the home owner, with `GOOGLE_PUBSUB_TOPIC`, and records the returned history id for an account
    with no stored state (`watchMailboxes` in `lib/mail-watch.ts` over `renewMailboxWatches` in
    `lib/new-mail.ts`). An account that needs
    connecting is logged and skipped; any other failure fails the cron run. Without the topic it
    does nothing. Renewing twice is harmless, so it claims no day. A second cron is fine on Hobby,
    which allows 100 per project, each at most once a day.
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
│   │   ├── calls.ts           # voice agent webhooks: call start briefing, ask_adam, post-call summary
│   │   ├── workouts.ts        # Strava/Hevy webhooks and signed QStash callbacks
│   │   └── mail.ts            # Gmail push via Pub/Sub, coalesced through QStash into one <new_email>
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
│   │   ├── reminder-list.ts   # shared upcoming-reminders list over a ReminderListStore (conditional-write retry)
│   │   ├── reminder-list-store.ts # the ReminderListStore in private Vercel Blob
│   │   ├── voice.ts           # ElevenLabs only: webhook auth, payloads → CallStart/CallRequest/CallEnded
│   │   ├── voice-agent.ts     # ElevenLabs only: the voice agent's config and syncVoiceAgent
│   │   ├── voice-agent-store.ts # the synced ElevenLabs ids and post-call secret in private Blob
│   │   ├── calls.ts           # vendor-free: call auth, owner caller check, messages, reply stream tap
│   │   ├── google.ts          # the only file that knows Google: Connect tokens, Gmail, Calendar, MIME
│   │   ├── google-accounts.ts # the owner's Google account names over a GoogleAccountStore, cached reads
│   │   ├── google-accounts-store.ts # the GoogleAccountStore in private Vercel Blob
│   │   ├── pubsub-push.ts     # Pub/Sub push: verify Google's OIDC token, decode the Gmail notification
│   │   ├── new-mail.ts        # coalescing, daily cap, the noteworthy filter, <new_email>, processMailbox, watch renewal
│   │   ├── mail-routes.ts     # the push and run route handlers behind channels/mail.ts
│   │   ├── mail-watch.ts      # watchMailboxes: start or renew every account's Gmail watch; stopWatchingMailbox
│   │   ├── mailbox-state-store.ts # per-account checkpoint, delivered ids and delivery lease in private Vercel Blob
│   │   ├── shared-cache.ts    # Vercel Runtime Cache, best effort; secretCache seals values and HMACs keys
│   │   ├── inbox-view.ts      # emails and events as the model sees them, untrusted text tagged
│   │   ├── mime.ts            # composeEmail: RFC 5322 plain-text message for drafts
│   │   ├── event-input.ts     # a date or an offset time from the model as an EventTime
│   │   ├── untrusted.ts       # wrap untrusted text in tags, strip look-alike tags
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
│   │   ├── reply_to_call.ts   # what the caller hears; only in a live call turn
│   │   ├── connect_google_account.ts # owner's direct chat only: add or reconnect an account by name
│   │   ├── disconnect_google_account.ts # workflow tool: confirm in chat, revoke, forget the name
│   │   ├── list_google_accounts.ts
│   │   ├── search_email.ts    # Gmail query across accounts, per-account errors
│   │   ├── read_email.ts      # one message, text body, attachments listed
│   │   ├── list_events.ts     # time range across accounts and calendars
│   │   ├── draft_email.ts     # save a draft or in-thread reply; never sends
│   │   ├── create_event.ts    # confirmed in chat; primary calendar, invites, Meet
│   │   ├── update_event.ts    # confirmed in chat; patch, merge attendees
│   │   └── agent.ts           # disables the built-in root-copy agent tool
│   └── schedules/
│       ├── briefing.ts        # 7am local: <briefing> into the home thread, silent unless something matters
│       └── mail-watch.ts      # 6am local: renew each account's Gmail watch on the Pub/Sub topic
├── scripts/
│   ├── sync-riz-mcp-skill.ts
│   ├── riz-mcp-skill.lock.json
│   ├── sync-voice-agent.ts    # after eve build on production: push the ElevenLabs voice agent's config
│   └── ts-resolve.ts          # lets node load authored `.js` imports from `.ts` (scripts and tests)
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
remembered across sessions with the `owner` memory slot · read-only Gmail and Google Calendar
across any number of Google accounts the owner connects by chatting (search, read, list events;
disconnect after a confirmation), with email and invites treated as untrusted data · new inbox mail as a trigger through Gmail push, texted only when a real
person needs the owner · calls to Adam's own phone number through one ElevenLabs voice agent,
answered from the owner's own thread, with texts mid-call and the call
joining the chat history afterwards.

**Out (deferred):** Redis · semantic memory recall · multi-user · multi-channel · `inbox` and `finance`
subagents · sending mail (drafts only, by design) · deleting events and answering invites · mail in the briefing · inbound burst debouncing (low-risk single-user; add a Photon
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
BLOB_READ_WRITE_TOKEN=...           # optional; private Vercel Blob store for generated audio, the home delivery target, owner memory and the Google account list
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
CALLS_TOOL_SECRET=...               # optional; x-calls-secret header on the calls start webhook and ask_adam
ELEVENLABS_API_KEY=...              # optional; the production build syncs the voice agent with it
ELEVENLABS_VOICE_ID=...             # optional; the voice agent's voice
CALLS_PHONE_NUMBER=...              # optional; Adam's number in E.164, assigned to the voice agent
GOOGLE_CONNECTOR=...                # optional; the one Vercel Connect Google connector (id scl_… or UID google/<name>); accounts are added in chat
GOOGLE_PUBSUB_TOPIC=...             # optional; projects/<project>/topics/<topic> Gmail watches publish to; unset, no watch
GOOGLE_PUSH_SERVICE_ACCOUNT=...     # optional; the push subscription's service account email; unset, every push is refused
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
- Calls need an Australian Twilio local number (an ID and address bundle is approved first),
  imported once in ElevenLabs → Phone Numbers, and in the Production environment
  `CALLS_TOOL_SECRET`, `ELEVENLABS_API_KEY` and `CALLS_PHONE_NUMBER`. The next production deploy
  creates the ElevenLabs agent, tool, secret and webhooks and assigns the number (look for
  `[voice-agent] synced` in the build log); importing the number is the only dashboard step.
  Without `CALLS_TOOL_SECRET` the start and ask routes answer 503, and until a sync has run the
  ended route does too; nothing else changes.
- Google (the PR #33 description is the step-by-step runbook): a Google Cloud project with the
  Gmail and Calendar APIs enabled; Google Auth Platform set to External, with the four scopes under
  Data Access, published In production under Audience (in Testing, refresh tokens die after 7
  days); and a Web application OAuth client whose redirect URI is Vercel Connect's
  `https://connect.vercel.com/callback`. From that client make one connector with `vercel connect
  create google --connection-method oauth --name adam-google --data @credentials.json` (delete the
  file afterwards; the secret never goes into chat or logs), attach it to the project, set
  `GOOGLE_CONNECTOR` to the `scl_…` id `create` prints (or the UID `google/adam-google`; Connect
  finds no connector by the bare name `adam-google`, and `env.ts` refuses it), and redeploy. Then
  text Adam "connect my <name> gmail" in a direct chat, once per account, and pick that account on
  Google's screen. The account list needs the Blob store.
  Expect the unverified-app warning at consent. A Workspace admin may have to allow the client
  before a work account can connect. Connect bills per token request (Hobby includes 500 a month, overage about $3 per
  1,000). Each Google access token lives an hour and is shared through Runtime Cache for about 55
  minutes, so it costs at most one request per account per hour Adam touches that account, whatever
  the number of instances. Newsletters arrive overnight too, and every mail run maps its address by
  touching every account, so with new-mail triggers on expect about 24 requests per account per
  day: about 720 a month per account, 1,440 with two, roughly $3 a month of overage on Hobby.
  Without new-mail triggers it is far fewer.
  The account list costs one Blob write per connect of a new name or disconnect, and about 24
  reads a day.
- New-mail triggers (the PR #39 description is the step-by-step runbook) need, in the same Google
  Cloud project: the Pub/Sub API, a topic, the
  Pub/Sub Publisher role on it for `gmail-api-push@system.gserviceaccount.com`, and a push
  subscription to `${BASE_URL}/eve/v1/mail/push` with authentication enabled (a service account,
  audience exactly that URL). Set `GOOGLE_PUBSUB_TOPIC` to the full topic name and
  `GOOGLE_PUSH_SERVICE_ACCOUNT` to the subscription's service account, then redeploy. The watch
  starts on the next `mail-watch` run; to start it now, run the `mail-watch` job from Settings →
  Cron Jobs (or POST `/eve/v1/dev/schedules/mail-watch` under `eve dev`), or ask Adam in chat which
  Google accounts are connected, which starts the watch for each connected one. Leave the
  subscription's "payload unwrapping" off (with it on every push is acknowledged as malformed) and
  give it an exponential-backoff retry policy. Mail that arrives before the first watch is never
  triggered on.
- QStash's free tier is 1,000 messages a day, and every retry counts as another message. Mail
  costs one per three-minute window with inbox activity per mailbox, capped at 120 a day per
  mailbox: 240 a day with two accounts at the very worst, a realistic 30 to 100. Coding watches
  spend up to one a minute while Devin is busy (about 250 for a long session), reminders one each,
  workouts two each. The cap keeps mail under a quarter of the budget, so reminders always fit.
- Vercel Blob on Hobby includes 2,000 advanced operations (put, copy, list) and 10,000 simple ones
  (a read that misses the cache, a head) a month; deletes are free. Going over locks Blob for 30
  days, which would take the home pointer, reminders, memory and the briefing down with it.
  A rough month for one owner:
  - the home pointer: one put the first time each new instance sees a direct message (it remembers
    what it last wrote), about 100 to 600 advanced; reads go through the CDN cache and mostly cost
    nothing.
  - the reminder list: a read and a write per schedule, cancel and delivery (list also prunes),
    about 150 advanced and 250 simple for 60 reminders.
  - daily claims for the briefing: 30 advanced, 30 simple.
  - owner memory: one simple read per turn of root, `coach` and `deep` (about 1,500 to 3,000),
    one put per save (about 30 to 60).
  - generated audio: one put and one read per voice note (about 10 to 20 each).
  - new mail: one put per delivered heads-up plus a checkpoint at most every six hours per mailbox,
    about 90 + 240 = 330 advanced and a similar number of simple reads with two accounts, plus a
    daily read per account from `mail-watch`. Disconnecting deletes the account's checkpoint.
    Each mail run also reads the home pointer first (`homeDelivery()`), through the CDN cache:
    a realistic 30 to 100 runs a day (240 at the cap with two accounts), counted here at worst as
    900 to 3,000 simple a month.
  - the Google account list: one put per account connected or disconnected (a handful), and a read
    each time its one-hour Runtime Cache entry lapses, about 720 simple; the address and token
    lookups behind each push stay in Runtime Cache.
  That is roughly 700 to 1,250 advanced and 3,600 to 7,400 simple a month: inside the limits, with
  the home pointer the largest variable. Check Observability → Blob after the first month.

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
   **Read-only reads are built** (§4): connect any number of accounts by chatting, disconnect, list
   accounts, search and read mail, list events, on root Adam, with Vercel Connect holding the Google
   grants. **New-mail triggers are built**
   (§4, `channels/mail.ts`): Gmail push through Pub/Sub, coalesced through QStash, filtered, and
   delivered as one `<new_email>` to the home thread where root exercises right-to-silence. Next:
   mail in the briefing, and an `inbox` subagent if triage crowds root's context. **Writes are
   built** (§4 "Writes"): drafts, never sends, and event create/update behind `ctx.ask`.
   - **Seam.** `lib/google.ts` is the only file that knows Google. Tools speak in accounts named by
     label or address and take an `account` argument or search all of them. Built on the Google REST
     APIs directly with `fetch`, the shape ChatGPT, Grok, Claude and Poke use for Gmail: OAuth through
     a managed token service plus small typed tools, with the token never in the model's sandbox. Google's `gws` CLI was rejected: a binary with interactive,
     on-disk login, not an officially supported Google product, pre-1.0, and its README confirms
     neither multi-account nor an MCP mode.
   - **Auth.** One Google Cloud OAuth client the owner creates, brought to Vercel Connect as one
     `google` connector; each account is its own Connect subject under the owner, so the owner adds
     accounts by chatting and no new setup is needed per account. Connect's Google service sends `access_type=offline` and `prompt=consent`, stores
     the refresh token and refreshes. In "Testing" status Google's refresh tokens expire after 7 days,
     so publish the consent screen (an unverified-app warning is fine for one user).
   - **Safety.** Adam drafts mail and never sends it; the owner sends from Gmail. Writing events is
     confirmed in chat with `ctx.ask`, as `merge_pull_request` is. Mail is untrusted input: bodies reach the model as
     content, never instructions, so nothing read from an email acts without that confirmation.
2. **Voice calls.** Call Adam like texting it, with the same context, and have it act mid-call.
   - **Status: built** (§4 "Calls") on ElevenLabs Agents over a Twilio local number, pending the
     owner's setup. The open question below is answered: the `calls` route taps the owner thread's
     event stream for Adam's `reply_to_call`. WhatsApp calling was dropped; a voice line on Photon
     remains a later swap in the dashboards with no change in Adam. Follow-ups: keep the full
     transcript (Blob, linked from the summary) so later turns can look up details compaction lost,
     and outbound calls (Adam rings the owner for something urgent) as one more delivery channel.
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
     `coding-sessions` delivers updates. Adam stays the only agent, so a call works through chat's
     context and tools, apart from the chat-only actions §4 lists: "text me photos of that place"
     lands in iMessage mid-call. `lib/voice.ts` and `lib/voice-agent.ts` are the only files that know the voice vendor. Adam's
     answer returns to the call through the session's event stream (see Status).
   - **After the call.** A `<call_ended>` trigger carrying the transcript summary enters the home
     session with `turnPolicy: "queue"`, and Adam calls `stay_silent`: the call joins chat history
     without a recap on the phone. The call-start briefing is persona, local time and the
     `ask_adam` rule only; recent context stays in the thread, one `ask_adam` away.
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
   triggers are built in `mail` (item 1): Gmail `users.watch` to Pub/Sub, renewed daily by
   `mail-watch` (a watch expires after 7 days). Pushes are lossy, but each run reads history from
   the stored id, so a missed push is caught up by the next one.
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
