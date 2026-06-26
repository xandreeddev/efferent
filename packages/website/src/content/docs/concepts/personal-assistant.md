---
title: The personal assistant — sessions, seats, and agents you jump into
description: efferent's chat-first model — a fast, direct coder by default, opt-in background fleets for wide work, the session → fleet → agent data model, the Workspace port and its HTTP/SSE wire, and how a turn executes end to end.
sidebar:
  label: The personal assistant
  order: 10
---

efferent is a **personal engineering assistant** you chat with. By default it is a **fast, direct
coder**: it reads, edits, runs, and tests in one tight loop, doing the work itself — a bug fix, a
single-area feature, a question. When the work is genuinely wide or parallel, it can spin up a
**fleet** — a coding team or a research team — that runs in the background and reports back. That's
**opt-in**, not the default. Every agent in a fleet is a session you can **jump into** and talk to, as
if it were a single coherent agent. This page is the mental model end to end: the domain types, the
data model, what crosses the wire, and how a turn actually executes.

## Mental model

```
daemon  ── the per-workspace infrastructure (one process, HTTP/SSE)
  └─ session ── a chat you resume (a conversation)
        └─ fleet ── a background team the agent spun up (a coordinator + its team)
              └─ agent ── one worker in that fleet (a sub-agent run)
```

Two entry points share **one** chat-first TUI over the **same** `Workspace` interface:

- **`efferent`** — the assistant, daemon-backed (the default master TUI). A split screen: the **chat**
  on the left, a **live fleet tree** on the right (every agent from this session, with running/idle
  status). N resumable sessions. It does the work directly by default, and when a task is wide enough it
  spins up a background coding/research fleet, does follow-ups, and schedules jobs.
- **`efferent code`** — a focused, fast, in-memory coder (no daemon), same TUI and the same "jump into
  any agent" capability, scoped to one session.

The organizing principle is *one workspace · many sessions · one seat*: you attend to exactly one thing
at a time and **move your seat** — the left chat re-points to whichever agent you select — rather than
juggling panes.

## The domain — value objects & entities

Everything is defined once, transport-agnostically, in `@xandreed/sdk-core`. The identifiers are branded
UUIDs so you can't cross them by accident:

```ts
// entities/Conversation.ts, entities/AgentContext.ts
export const ConversationId = Schema.UUID.pipe(Schema.brand("ConversationId"))
export const ContextNodeId  = Schema.UUID.pipe(Schema.brand("ContextNodeId"))

// ports/Workspace.ts — a SessionId is whichever of the two a frontend is pointing at.
// A root session IS a ConversationId; an agent session IS a ContextNodeId. One UUID
// crosses the wire; `kind` disambiguates.
export const SessionId   = Schema.UUID.pipe(Schema.brand("SessionId"))
export const SessionKind = Schema.Literal("root", "agent")
```

A **session** the UI lists is a `SessionSummary` — the same shape whether it's the root chat, a fleet,
or a leaf agent:

```ts
// ports/Workspace.ts
export const SessionSummary = Schema.Struct({
  id: SessionId,
  kind: SessionKind,                  // "root" (a conversation) | "agent" (a context node)
  title: Schema.optional(Schema.String),
  folder: Schema.String,              // the dir it's scoped to (writes/bash confined here)
  status: SessionStatus,              // running | ok | error | idle | interrupted
  parentId: Schema.NullOr(SessionId), // the enclosing session, or null for a root
  model: Schema.optional(Schema.String), // a fleet's pinned model, root-only
})
```

A **fleet** and an **agent** are both `AgentContextNode`s — nodes in the persistent, branching context
tree. The tier is explicit in the `kind` field:

```ts
// entities/AgentContext.ts
export const NodeKind = Schema.Literal("fleet", "agent")

export const AgentContextNode = Schema.Struct({
  id: ContextNodeId,
  parentId: Schema.NullOr(ContextNodeId),        // null = a top-level node under a session
  rootConversationId: Schema.NullOr(ConversationId), // which session this whole tree hangs off
  edgeKind: EdgeKind,                            // "spawned" | "branched" | "resumed"
  folder: Schema.String,
  kind: Schema.optional(NodeKind),               // "fleet" (a task) | "agent" (a worker)
  seed: ContextSeed,                             // task | selection | handoff descriptor
  status: ContextNodeStatus,                     // running | ok | error
  returnSummary: Schema.optional(Schema.String), // what it handed back when finished
  filesChanged: Schema.Array(Schema.String),
  usage: Schema.optional(ContextUsage),          // billed tokens
  // …createdAt, endedAt, workspaceRef (the git HEAD at finish, for staleness)…
})

// A legacy row with no `kind` still resolves cleanly:
export const nodeKind = (n) => n.kind ?? (n.parentId === null ? "fleet" : "agent")
```

## Data model

Two stores, joined loosely by `rootConversationId` so a session and its agent tree can persist
independently:

```
conversations            ── a SESSION (the resumable root chat)
  id, workspace_dir, title, model, pending_prompt, created_at
  ├─ messages            ── (conversation_id) the session's turn history
  └─ checkpoints         ── (conversation_id) handoff folds (summary + fold position)

context_nodes            ── a FLEET or an AGENT
  id, parent_id, root_conversation_id, edge_kind, folder, kind,
  status, return_summary, files_changed, usage, workspace_ref, …
  └─ context_messages    ── (node_id) the node's own message history
```

So the three tiers map cleanly:

| Tier | Stored as | Identified by |
|---|---|---|
| **session** | a `conversations` row | `ConversationId` |
| **fleet** | a top-level `context_nodes` row (`kind = 'fleet'`, `parent_id` null) | `ContextNodeId` |
| **agent** | a deeper `context_nodes` row (`kind = 'agent'`) | `ContextNodeId` |

:::note
SQLite is the zero-config default (`~/.efferent/efferent.db`, honouring `EFFERENT_HOME`); Postgres is
opt-in via `EFFERENT_DB_URL`. Both run the same migrations (`Migrator.fromRecord`, bundled inline). The
`kind` column arrived in pg migration `0013` / sqlite `0009`.
:::

## The seam — the `Workspace` port

The whole UI — both entry points — depends only on one interface, never on HTTP. Two adapters satisfy
it: the **in-process** one (`efferent code` and what the daemon hosts) and the **remote** one (the
default `efferent` client). Pick the impl at the composition root; the frontend code is identical against
either.

```ts
// ports/Workspace.ts (excerpt)
export class Workspace extends Context.Tag("@xandreed/sdk-core/Workspace")<Workspace, {
  readonly snapshot:    () => Effect.Effect<WorkspaceSnapshot, WorkspaceError>
  readonly listSessions:() => Effect.Effect<ReadonlyArray<SessionSummary>, WorkspaceError>
  readonly getState:    (id: SessionId, since?: number) => Effect.Effect<SessionState, WorkspaceError>
  readonly send:        (id: SessionId, prompt: string) => Effect.Effect<void, WorkspaceError>
  readonly interrupt:   (id: SessionId) => Effect.Effect<void, WorkspaceError>
  readonly createFleet: (req: CreateFleetRequest) => Effect.Effect<SessionId, WorkspaceError>
  readonly subscribe:   (id: SessionId, since?: number) => Stream.Stream<SeqEvent, WorkspaceError>
  readonly metrics:     () => Effect.Effect<WorkspaceMetrics, WorkspaceError>
  // …spawn, stop, approve, getSettings/updateSettings, getDirective/setDirective…
}>() {}
```

`getState` returns the **persisted messages** plus live status; the client replays them through its own
reducer, so presentation stays 100% client-side and the daemon only ever ships `AgentMessage`s and
`AgentEvent`s — never UI blocks.

## On the wire — HTTP + SSE

The transport (`packages/cli/src/transport/http/`) is the *only* place HTTP appears, and it maps the
port **1:1**. The server (`server.ts`) hosts the in-process Workspace; the client (`client.ts`) turns the
endpoints back into `Workspace`-shaped calls for the remote adapter.

```text
GET  /snapshot                  → WorkspaceSnapshot { sessions, directive, activeSessionId }
GET  /sessions                  → SessionSummary[]
GET  /sessions/:id/state?since= → SessionState { session, log, busy, pendingApproval, cursor }
GET  /metrics                   → WorkspaceMetrics      (token/cost/RED, from the metric registry)
POST /sessions/:id/send {prompt}→ 204   · start/continue a turn (or steer a running agent)
POST /fleets   {folder,task?}   → SessionId            · create a fleet
POST /sessions/:id/{interrupt,stop,model,approve}
GET  /sessions/:id/events?since=→ text/event-stream    · the live event stream (below)
POST /auth/reload · POST /shutdown · GET|POST /settings · /directive
```

The event stream is the heart of it. Every frame is a `SeqEvent` — a monotonic sequence number (for
replay-from-`since` on reconnect) wrapping an `AgentEvent` — merged with a keep-alive heartbeat:

```ts
// ports/Workspace.ts
export const SeqEvent = Schema.Struct({ seq: Schema.Number, event: AgentEvent })
```

```text
data: {"seq":41,"event":{"type":"assistant_message","text":"On it — spawned …","usage":{…}}}
data: {"seq":42,"event":{"type":"subagent_start","nodeId":"38670bc4…","name":"summarize Effect.ts"}}
data: {"seq":43,"event":{"type":"tool_start","name":"web_fetch","subAgentNodeId":"38670bc4…"}}
: heartbeat
```

`AgentEvent` is an additive union (`assistant_message`, `tool_start`/`tool_end`, `subagent_start`/`_end`,
`error`, `board_note`, …). Inner sub-agent events carry `subAgentNodeId`, which is exactly what lets the
TUI route a node's activity into its own log — see "jump into any agent" below.

## Boot — attach or spawn

```ts
// server/attach.ts — the transparent lifecycle
const existing = yield* readDiscovery(workspace)            // ~/.efferent/daemon-<hash>.json
if (existing && (yield* probeHealth(baseUrlOf(existing))))
  return { baseUrl: baseUrlOf(existing) }                   // a healthy daemon → attach
// else spawn one, detached, and poll until it registers:
Bun.spawn([process.execPath, entry, "--mode", "daemon-serve", "--cwd", workspace]).unref()
```

`efferent` resolves to the **remote** driver, which `attachOrSpawn`s the per-workspace daemon (a tiny
discovery file finds or spawns it) and then renders the chat-first TUI as a thin client. `efferent code`
resolves to the **in-process** driver — the same TUI, but the Workspace is built in-memory in the same
process, no daemon. Same code, two backends.

## A turn, end to end

```text
you type  ─▶ ws.send(sessionId, prompt)
            ─▶ POST /sessions/:id/send            (remote only; in-process skips the wire)
            ─▶ inProcess.send  ──┬─ running?  → bus.post(mailbox)        (steer a live agent)
                                 ├─ busy?     → queue
                                 └─ a root session → startRootTurn(cid, prompt)
                                                  └─ runAgent(config, cid, prompt, hooks, cwd, model)
                                                       forked as a daemon fiber
```

`runAgent` (`usecases/runAgent.ts`) seeds the ambient run context and drives the loop. `@effect/ai`
resolves one model step's tool calls, but iterating across turns is ours: each turn maps the buffer to a
`Prompt`, calls `LanguageModel.generateText`, appends the response, and re-invokes until the model stops
asking for tools.

```ts
// usecases/agentLoop.ts (shape)
while (turn < maxSteps) {
  const res = yield* LanguageModel.generateText({ prompt, toolkit })  // resolves THIS step's tools
  buffer.push(...responseToAgentMessages(res.content))                // events publish to the ledger → SSE
  if (res.finishReason !== "tool-calls" || res.toolCalls.length === 0) break
}
```

Every event the loop emits is published to a single per-workspace **ledger**; `subscribe` is that ledger,
so any number of clients tail the same stream and rebuild their view from `seq`.

## Direct by default — delegation is opt-in

The root agent runs `coderPrompt` and has the **full coding toolkit**, so it just does the work in its
own loop. A background fleet is **opt-in**, governed by a prompt-only `# When to delegate` policy
(`renderDelegationPolicy`, emitted only when a `coordinator`/`research-coordinator` lead is in the
roster): reach for a fleet only on **breadth** (≥3 independent areas), **scale** (a change spanning many
packages that would blow the context window serially), or **async intent** (fire-and-forget or a
scheduled, unattended job) — otherwise the agent does it itself. No code decides routing; the model does.

When it does delegate, that's just the `run_agent` tool — which forks a background sub-agent and
**returns immediately**:

```ts
// the model calls, e.g.:
run_agent({ agent: "research-coordinator", folder: ".", task: "summarize what Effect.ts is" })
//   → { nodeId, name, status: "running" }   — non-blocking; the assistant replies "on it, jump in"
```

```ts
// sdk-core/usecases/buildScopeRuntime.ts — makeRunAgentHandler (shape)
const node = yield* store.spawn({ parentId, rootConversationId, folder, seed, kind: "fleet" })
yield* bus.markRunning(node.id, name, { parentKey })       // siblings can address it at once
const fiber = yield* Effect.forkDaemon(runSpawnedAgent(node, …))  // background; returns now
return { nodeId: node.id, name, status: "running" }
```

The spawner collects results **without blocking** via `wait_for_agents`, which parks only the caller's
fiber on the `Supervisor` (the in-process bus) until a watched agent finishes, a message lands in its
inbox, or a timeout — mailboxes, a shared blackboard, and per-run completion `Deferred`s. The
coordinator leads its specialists (`frontend`/`backend`/`qa`/`product`), validates each piece with a
read-only `architect`, and reports up; the research-coordinator fans out web `researcher`s and
synthesizes. See [sub-agents](/docs/concepts/sub-agents/) and [the fleet](/docs/concepts/fleet/).

## Jump into any agent

Select any node in the fleet tree and the **left chat re-points** to that agent's live session — its
status, its current work, and the composer wired to it. It reads as one coherent agent.

The machinery is already there: the event pump tags every inner event with `subAgentNodeId` and appends
it to that node's own log (`store.nodeLog(id)`); opening a node renders that log instead of the
conversation; the composer routes through `submitToNode`:

```ts
// cli/actions/submit.ts — talking to the agent you jumped into
if (yield* bus.isRunning(nodeId)) yield* bus.post(nodeId, { from: "you", content: text })  // steer it live
else yield* scopeRuntime.resumeNode({ nodeId, task: text })                                // resume a finished one
```

A live agent reads your message at its next turn boundary (its `onTransformContext` drains the inbox); a
finished one resumes in place. `Esc` returns the chat to the assistant.

## Memory — read fresh, keep the *why*

An agent always reads code **fresh**, so it's never stale — but an engineer also accumulates *why* a thing
is the way it is. efferent keeps that in a small, curated, durable layer: ADR-style markdown under
`.efferent/memory/`. The index (title + summary) is injected into the system prompt at session start
(`# Project knowledge`, mirroring [skills](/docs/concepts/skills/)); the agent reads a full record with
`read_memory({ name })` and records a new decision with `remember({ title, content })` — which appends a
timestamped entry, never clobbers. So sessions build on each other without dragging a giant stale context.

## Where it lives

```
packages/sdk-core/src/
  ports/Workspace.ts          the seam: SessionId/Summary/State, SeqEvent, the interface
  entities/AgentContext.ts    AgentContextNode, NodeKind, nodeKind
  usecases/runAgent.ts        drives a session's turn ; agentLoop.ts iterates
  usecases/buildScopeRuntime  run_agent / wait_for_agents over the Supervisor + context tree
  usecases/agentBus.ts        the Supervisor: mailboxes, blackboard, supervision (a threaded value)
packages/cli/src/
  workspace/inProcess.ts      the authoritative Workspace + the JobController (the daemon hosts it)
  workspace/remote.ts         the remote Workspace (calls the transport client)
  transport/http/             server.ts + client.ts + the SSE codec — the ONLY HTTP
  server/{daemon,attach,discovery}.ts   the per-workspace daemon lifecycle
  cli/                        the one chat-first TUI (both entry points) + the event pump
```

The takeaway: one transport-agnostic port, one persistent context tree, and a single event stream —
which is why a chat, a background fleet, and an agent you jump into are all the same thing wearing
different hats.
