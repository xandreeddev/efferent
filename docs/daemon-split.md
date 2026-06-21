# Implementation plan: split the agent into a persistent daemon + thin HTTP/SSE clients

> Status: **in progress — Phase (a) foundation landed, green.** This is the canonical,
> self-contained implementation reference (so it survives context compaction). Mirror of the
> approved session plan, expanded with code anchors (`file:line`) and concrete shapes so an
> implementer needn't re-explore. See **Progress log** below for what's done vs. next.

## Progress log

**Landed & green (typecheck + 580 tests pass) — the Phase (a) contract + backend:**

1. **`AgentEvent` is now a `Schema.Union`** in `packages/sdk-core/src/entities/AgentEvent.ts`
   (moved off the hand-written union in `packages/code/src/events.ts`, which re-exports it). Both the
   loop's hooks and the future wire share one shape. `nodeId`/`parentNodeId` stay plain strings.
2. **`Directive` moved to sdk-core** (`entities/Directive.ts`, Schema + `parseDirective`/
   `renderDirectiveSection`); `code`'s `usecases/directive.ts` re-exports it + keeps the verifier role.
3. **`ApprovalRequest`/`ApprovalDecision` promoted to Schemas** (`ports/Approval.ts`) — same `.Type`,
   so consumers unchanged; needed so the protocol serializes.
4. **`Workspace` port + full protocol Schemas** in `packages/sdk-core/src/ports/Workspace.ts`:
   `SessionId` (brand + `conversation/nodeSessionId` + `session{Conversation,Node}Id` converters),
   `SessionSummary`, `SeqEvent`, `SessionState`, `WorkspaceSnapshot`, `SpawnRequest`, `ImportResult`,
   `WorkspaceError` (Schema.TaggedError), and the 13-method `Workspace` Tag. Transport-agnostic.
5. **Incremental per-turn persistence:** `runAgentLoop` gained an `onTail?(messages)` callback
   (`usecases/agentLoop.ts`), called after each `newTail` append (corrective + normal tail). `runAgent`
   passes `persistTail` (per-turn `store.append`, `orDie` on failure) and dropped the end-of-run bulk
   append. Direct/eval callers (no `onTail`) are unchanged.
6. **In-flight marker:** `ConversationStore` gained `markPending(id, prompt)` / `clearPending(id)` /
   `listPending(workspaceDir)` (port + sqlite + postgres + switchable + in-memory impls), backed by a
   nullable `pending_prompt` column (migrations pg `0011_pending_turn`, sqlite `0007_pending_turn`).
   `runAgent` marks pending before the loop (best-effort) and clears on completion. Tests added in
   `conversationStore/sqlite.test.ts`.
7. **Event ledger** (`packages/code/src/workspace/eventLedger.ts` + `.test.ts`, 8 tests): the
   multi-client fan-out + reconnect core — monotonic `seq`, bounded ring (`DEFAULT_LEDGER_RING`),
   `PubSub`; `publish`, `latestSeq`, `hasGap(since)` (→ resync), `replay(since)`, and
   `stream(since)` (subscribe-then-snapshot, seam-deduped — exactly-once, in order). This is the
   plan's "highest-risk correctness" piece, landed with tests first as recommended.
8. **Publish-based hooks** (`packages/code/src/events.ts`): `makeAgentEventHooks(publish, …)` is the
   single event-construction point; `makeEventHooks(queue, …)` is now a thin Queue adapter over it,
   and the in-process Workspace builds hooks that publish to the `EventLedger`.
9. **In-process Workspace adapter** (`packages/code/src/workspace/inProcess.ts` + `.test.ts`, 2 tests
   driven by a fake `LanguageModel`): `makeInProcessWorkspace(deps)` — the authoritative owner. It
   builds one `buildScopeRuntime` (baseHooks → ledger), owns the ledger + a directive `Ref` + a
   per-session run state (busy/fiber/queue), and forks runs on a captured runtime so `send` returns
   immediately while the turn streams. Implements all 13 `Workspace` methods: `send` (root → `runAgent`
   with rootHooks draining the bus inbox; busy → `bus.post` else queue; `finishTurn` requeues human
   msgs + drains the next), `send(node)` → `resumeNode`/`bus.post`, `subscribe` → `ledger.stream`,
   `getState`/`snapshot`/`listSessions` (root + `ContextTreeStore.listTree` nodes), `interrupt`/`stop`,
   `spawn` → `scopeRuntime.spawnAgent` + fleet, `getDirective`/`setDirective`, `importAgents/Tools`.
   The UI-free distillation of `submit.ts`/`spawnAgent.ts`/the `runtime.ts` directive closure.

10. **SSE codec** (`packages/code/src/transport/http/sse.ts` + `.test.ts`, 8 tests): the wire framing
    — `encodeSeqEvent` (`id:<seq>\nevent:agent_event\ndata:<JSON>\n\n`), `encodeResync`/`encodeNamed`/
    `encodeHeartbeat`, a chunk-tolerant `makeSseParser` (CRLF, multi-line `data:`, leading-space strip,
    `:`-comment skip, frames split across chunk boundaries), and `frameToSeqEvent` (Schema-validated
    decode). The ONLY place the SSE byte format lives; server + client both build on it. (Phase b.)

11. **HTTP server** (`packages/code/src/transport/http/server.ts`): `workspaceRouter(identity)` maps
    the endpoint table to the `Workspace` Tag (`/health`, `/snapshot`, `/sessions` GET+POST,
    `/sessions/:id/{state,send,interrupt,stop,approve}`, `/sessions/:id/events` SSE,
    `/directive` GET+POST, `/agents|tools/import`); bodies via `HttpServerRequest.schemaBodyJson`,
    responses via `HttpServerResponse.schemaJson`, SSE via `HttpServerResponse.stream` over
    `ledger.stream` + a 15s heartbeat merge. `serveWorkspaceHttp({identity, port})` =
    `HttpServer.serve()(router)` over `BunHttpServer.layer({hostname:"127.0.0.1"})`. The ONLY HTTP
    server code. (`resync` on `hasGap` is deferred to phase d's restart path.)
12. **HTTP client** (`packages/code/src/transport/http/client.ts`): `makeHttpTransport(baseUrl)` →
    a `HttpTransport` of `Workspace`-shaped calls over `HttpClient` (every method maps wire failures
    to `WorkspaceError`); `subscribe` streams the SSE bytes through `makeSseParser`/`frameToSeqEvent`
    → `Stream<SeqEvent>`. The remote adapter (phase c) is a thin wrapper over this.
13. **Round-trip smoke test** (`transport/http/roundtrip.test.ts`, 2 tests): over a REAL loopback
    server (`BunHttpServer.layerTest`) + a fake model — `snapshot`, `send`, SSE stream to `agent_end`,
    `getState`. Proves the wire end-to-end.

14. **Remote Workspace adapter** (`workspace/remote.ts`): `makeRemoteWorkspace(baseUrl)` wraps the
    HTTP transport into a `Workspace` service (captures `HttpClient`, re-provides per call → R=never);
    `RemoteWorkspaceLive` builds a `FetchHttpClient`. `remote.test.ts` drives a turn + directive over
    the wire. `workspace/fakeAppEnv.ts` consolidates the test fakes (stub ports + scripted model +
    in-process Workspace + a real loopback server via `BunHttpServer.layerTest`).
15. **Remote TUI driver** (`cli/remoteRuntime.ts`, behind `EFFERENT_REMOTE`): attaches to the daemon,
    reuses the whole view + store + `makeEventReducer`; `ctx.submit`→`ws.send` (optimistic user line),
    pump drains `ws.subscribe` with a reconnect/resync loop, rail seeded from `getState.log` via
    `applyContext`. The in-process `runtime.ts` is byte-for-byte untouched.
16. **daemon-serve + discovery + attach** (`server/{daemon,discovery,attach}.ts`): `runDaemonServe`
    serves the in-process Workspace on an ephemeral 127.0.0.1 port + writes/removes the discovery file
    + reconciles stranded `running` nodes; `attachOrSpawn` finds a healthy daemon or spawns a detached
    one. Smoke-verified: `--mode daemon-serve` boots through the real `AppLive` + serves `/health`.
17. **Restorability — auto-resume** (`resumeAgent` in core + the adapter's build-time check): a turn
    in flight at crash time is re-driven over persisted history (marker cleared first to bound retries).
18. **Approval round-trip** (`workspace/serverApproval.ts` + the `approval_needed`/`approval_resolved`
    events + `POST /approve` + `POST /auth/reload`): the daemon parks + publishes the request, a client
    answers, stale sheets clear; login stays client-side then `/auth/reload`.
19. **Multi-client fan-out test** (`transport/http/multiClient.test.ts`): two SSE subscribers on one
    session both receive a single run's stream.
20. **Docs** (`website/src/content/docs/concepts/daemon.md` + nav): the public "daemon / attach" page.

**Done: phases (a)–(f) + the reversible half of (g) — the daemon split is built, tested (26 new
tests), and smoke-verified. The TUI default is now the daemon/remote path; `EFFERENT_LOCAL=1` runs
the legacy in-process driver as a fallback (one-line revert in `main.ts`).**

**Remaining — the IRREVERSIBLE half of (g), deliberately gated:** DELETING the in-process
`runtime.ts`/`submit.ts`/`spawnAgent.ts`/client `approval.ts` + the `rpc.ts` shim. The remote TUI
mounts OpenTUI and can't be unit-tested here, so the delete waits on a manual soak: run `efferent` in
a real terminal (attach, send, spawn a fleet, detach/reattach, kill the daemon mid-turn → confirm
auto-resume, approve a bash command); if anything misbehaves, `EFFERENT_LOCAL=1` is the escape hatch
while it's fixed. Per the parent CLAUDE.md, any RELEASE of this default flip is outward-facing and
needs explicit sign-off. Smaller follow-ups: wire the remote TUI's post-login to `POST /auth/reload`;
an `efferent daemon {status,stop}` CLI + `:daemon` command; fold auto-handoff into the adapter's
`finishTurn`; per-agent-session ledgers + seat-switching; the cron tick inside the daemon.

## Why

Today the agent runs **in-process with the TUI** — the loop, the comms bus (`AgentBus`), the fleet,
the per-node logs, the directive, and the approval ledger are all Effect fibers/Refs inside the
OpenTUI process (`packages/code/src/cli/runtime.ts`). So: closing the UI kills the fleet; live state
is ephemeral; Esc/teardown is fragile; you can't reattach; and a context node whose process dies is
stranded `status="running"` forever.

Fix = the project's deferred **`Workspace` port** plan ("one workspace · many sessions · one seat"),
realized as a **tmux-style split**: the agent runs as a **separate, persistent per-workspace daemon**;
the TUI (and a future htmx/SSE web UI) are **thin clients** that attach over a **swappable transport**
(HTTP+SSE first). The daemon owns all live state; any number of clients attach/detach and steer the
same live sessions; the daemon is **crash-restorable** (sessions, history, directive, approvals come
back — and an in-flight turn auto-resumes).

## Confirmed decisions

- **tmux-style:** one persistent daemon per workspace; N clients attach/detach concurrently, all see
  & steer the same sessions; detaching leaves the daemon + fleet running.
- **Transport is a swappable last-layer adapter.** Agent, `Workspace` port, and frontends depend
  ONLY on the port + a transport-agnostic protocol (serializable Schemas) — never on HTTP. The wire
  is one transport-adapter *pair* (server "expose a Workspace over T" + client "produce a Workspace
  from T"); swap for unix-socket/websocket/in-process with no change to agent or UI code.
- **First transport: HTTP + SSE** (`@effect/platform` on a localhost TCP port) — to serve **multiple
  frontends** (browser web UI *and* terminal TUI; a unix socket can't serve a browser). Just the
  first impl of the transport contract.
- **Auto-spawn + attach (transparent).** `efferent` detects a daemon for the workspace (discovery
  file); attaches if present, spawns a detached one if not.
- **Go straight to the split**, behind the `Workspace` port so in-process & remote share one
  interface; phased so steps stay verifiable.
- **Crash-restorable, in-flight turns resumed.** A daemon restart rebuilds sessions/history/directive/
  approvals from the DB and **re-drives a turn that was mid-flight** when it died.

## Architecture — three layers, dependency strictly inward

```
 clients (attach/detach, tmux-style)        daemon (persistent, one per workspace)
 ┌──────────────┐  commands (POST) ┌────────────────────────────────────────────┐
 │ TUI (OpenTUI) │ ───────────────▶ │ transport/http/server (HttpRouter + SSE)    │
 │ TUI #2 / web  │ ◀──── SSE ─────  │   └ in-process Workspace adapter (authority) │
 └──────────────┘  event stream    │       ├ buildScopeRuntime + AgentBus + Fleet │
   (N clients, one session)         │       ├ per-session event ledger (PubSub+ring)│
        ▲ remote Workspace          │       ├ directive + approval ledger (server) │
        │ (transport-generic)       │       └ AppLive: stores, model, auth, settings│
        └ transport/http/client ────┴──────────────────┬─────────────────────────┘
                                     persisted (SQLite/PG): conversations, context tree,
                                     per-turn message tail, directive, approvals, in-flight marker
```

1. **`Workspace` port + protocol (sdk-core, transport-agnostic).** The interface + serializable
   Schemas for every command/event/state. No transport. The shared contract.
2. **`Workspace` implementations (`packages/code`).**
   - **in-process adapter** — wraps today's `buildScopeRuntime` + bus + fleet + stores; daemon-hosted;
     sole authoritative owner of live state; no transport knowledge.
   - **remote adapter** — implements `Workspace` by calling a *transport client*; its event stream
     feeds the existing `eventPump` reducer verbatim. Generic over the transport client.
3. **Transport adapter (swappable last layer, `packages/code/src/transport/`).** A server+client
   *pair* per transport. **HTTP/SSE first**; a unix-socket/websocket pair drops in beside it with no
   change to layers 1–2 or frontends. **`@effect/platform` HTTP/SSE code lives ONLY here.**

The split is cheap because the seam already exists:
- `packages/code/src/cli/TuiContext.ts:53-102` — the complete command/query surface (becomes the port).
- `packages/code/src/events.ts:13-82` — `AgentEvent` union, already JSON-serializable (the SSE payload).
- `packages/code/src/cli/events/eventPump.ts:48` — `makeEventReducer` is a pure `(AgentEvent)=>void`
  over the store; reused verbatim as the client-side stream consumer.
- `packages/code/src/cli/presentation/historyProjection.ts` `projectHistory` — already rebuilds the
  rail + activity tree from persisted messages (how resume/build/fork/boot work). The DB-rebuild
  backbone for `/state` and restorability.

### Transport decoupling (the key structural rule)

- **Nothing above layer 3 imports HTTP/SSE.** Agent loop, in-process Workspace, remote Workspace,
  TUI, web UI all reference only the port + protocol Schemas.
- **Frontend identical against in-process or remote.** The TUI takes a `Workspace` Layer: inject the
  in-process one → runs daemonless (quick/CI/print, no transport); inject the remote one → attaches
  to the daemon. Transport is chosen at the composition root, not a UI dependency.
- **Swapping transports = one new `transport/<name>/{server,client}.ts` pair** against the same
  Schemas. HTTP is the reference impl; e.g. `transport/http/server.ts` (HttpRouter+SSE) +
  `transport/http/client.ts` (HttpClient+SSE parser). Daemon = AppLive + in-process Workspace +
  `transport/http/server`. Client = `transport/http/client` + remote Workspace + view.

## The `Workspace` port (sdk-core, dependency-free)

New `packages/sdk-core/src/ports/Workspace.ts` — mirrors `ports/Approval.ts` (Tag + colocated
Schemas/errors; imports only `effect` + core entities, no IO/HTTP). Requires moving the `AgentEvent`
union into sdk-core as a `Schema.Union` (new `packages/sdk-core/src/entities/AgentEvent.ts`,
re-exported from `events.ts` so `makeEventHooks` is unchanged) — both port and wire need it.

`SessionId` brands `ContextNodeId | ConversationId` (root session = its `ConversationId`, already the
bus key — `submit.ts:398`; agent session = `ContextNodeId`).

```ts
// sketch — Schemas are the transport-agnostic protocol
SessionSummary { id: SessionId; kind: "root"|"agent"; title; folder;
                 status: "running"|"ok"|"error"|"idle"|"interrupted"; parentId: SessionId|null }
SeqEvent       { seq: number; event: AgentEvent }                 // SSE/event-stream unit
SessionState   { session: SessionSummary; log: AgentMessage[]/*→projectHistory client-side*/;
                 busy: boolean; pendingApproval: ApprovalRequest|null; cursor: number /*last seq*/ }
WorkspaceSnapshot { sessions: SessionSummary[]; directive: Directive|null; activeSessionId: SessionId|null }

Workspace {
  snapshot(): Effect<WorkspaceSnapshot>
  listSessions(): Effect<SessionSummary[]>
  getState(id, since?): Effect<SessionState>
  send(id, prompt): Effect<void>
  interrupt(id): Effect<void>
  spawn({agent?, folder, task, title?}): Effect<SessionId>
  stop(id): Effect<void>
  subscribe(id, since?): Stream<SeqEvent>
  approve(id, decision: ApprovalDecision): Effect<void>
  getDirective(): Effect<Directive|undefined>;  setDirective(d): Effect<void>
  importAgents(spec): Effect<ImportResult>;  importTools(spec): Effect<ImportResult>
}
```

- `SessionState.log` is **persisted messages** (the client rebuilds `ScrollbackBlock`s by replaying
  through `makeEventReducer`/`projectHistory`) — presentation stays 100% client-side; the daemon
  serializes only `AgentEvent`s + messages, never UI blocks.
- `copySelection`/`exit`/`run`/`roles`/`tools` stay **client-only** (not on the port).
- `WorkspaceError` = one `Schema.TaggedError { message }` (crosses HTTP as a JSON body).

## In-process Workspace adapter (`packages/code/src/workspace/inProcess.ts`)

Authoritative owner of live state. Wraps:
- one `buildScopeRuntime(rootScope, opts, hooks)` (today `runtime.ts:104`) + its `scopeRuntime.bus`
  (`packages/code/src/usecases/agentBus.ts`).
- the `FleetSupervisor` (move `packages/code/src/cli/state/fleet.ts` → `workspace/`).
- a **per-session event ledger**: `Map<SessionId, { seq; events: AgentEvent[] (ring); hub: PubSub<SeqEvent> }>`.
  Replace the single `makeEventHooks` `Queue` with a **`PubSub`** (multi-subscriber fan-out); each
  event gets a monotonic `seq`, is appended to the ring, then published.
- the **directive** (move out of `runtime.ts:198` closure into a Ref + persistence).
- the **approval ledger + pending map** (move from `packages/code/src/cli/approval.ts`): session
  rules/folders Refs, the 1-permit gate (`approval.ts:56`), and `Map<SessionId, resume>` of parked
  `Effect.async` resumes (`approval.ts:59-70`). "Open modal" becomes "publish `approval_needed`".
- a server-side `Map<SessionId, Fiber>` replacing `store.run.getFiber` (`submit.ts:399`).

Method mapping (mechanical, given the seam):
- `send(root, text)` ← `submit.ts` body (auth gate, busy→mailbox `bus.post(cid)`, fork `runAgent`);
  `send(node, text)` ← `submitToNode` (`submit.ts:89-186`: live→`bus.post`, finished→`resumeNode`).
- `interrupt(id)` ← `bus.interrupt(id)` or `bus.interruptAll()` + fiber interrupt (`runtime.ts:219`).
- `spawn` ← `scopeRuntime.spawnAgent` + `fleet.register` (`spawnAgent.ts:54,96`).
- `stop(id)` ← `fleet.get` → `Fiber.interrupt` (`runtime.ts:232`).
- `subscribe(id, since)` ← replay ring `seq>since` then `Stream.fromPubSub(hub)`.
- `getState`/`snapshot` ← `ContextTreeStore.listTree` + `bus.listRunning`/`snapshot` + directive Ref
  + `projectHistory(ConversationStore.list/listActive)`.
- cron tick (`runtime.ts:372-400` / `daemon.ts:94-111`) ticks against this adapter inside the daemon.

## Restorability

Backbone: `projectHistory` already rebuilds UI from persisted messages → the DB is the durable truth.

1. **Incremental persistence (core backend change).** Persist each turn's tail as it lands:
   - root: `runAgent` (`packages/sdk-core/src/usecases/runAgent.ts:110-113`) appends `newTail` only
     after the loop → append per turn (per-turn hook on `runAgentLoop`, or inside the loop).
   - sub-agents: `runSpawnedAgent` (`buildScopeRuntime.ts:786`) appends only at `recordReturn` →
     per turn. (Also fixes "lose state on swap" at the source.)
2. **In-flight marker.** On `send`, persist a per-session "pending turn" marker; clear on `agent_end`.
3. **`/state` rebuilds from DB** via `projectHistory` + live status — fresh daemon == long-running.
4. **Daemon-start reconcile + auto-resume:** flip stranded `running` nodes
   (`ContextTreeStore.listTree`→`recordReturn`) — the existing stranded-`running` bug
   (`packages/sdk-adapters/src/contextTreeStore/sqlite.ts:160,200-216`, no cleanup today) — AND for
   each session/node with a pending marker, **auto-resume** by re-driving the loop over persisted
   history (existing resume path, automatic). Idempotency: incremental persistence means landed tool
   results are in the record, re-drive continues past them; only strictly mid-tool-call work
   re-attempts. **Cap auto-resume retries** per session (a turn that crashes the daemon must not loop).
5. **Persist** the directive (`directives` row) + session-scope approval grants (promote today's
   session-only Refs to a persisted set). Both survive restart.
6. The in-memory ledger is a cache: across a daemon restart a client's `since` is from a prior daemon
   → server replies `resync` → client re-fetches `/state` (DB rebuild) and resumes. No event lost.

## Multi-client fan-out (tmux-style)

One `PubSub` per session (replaces the single `makeEventHooks` `Queue`): producer = the one agent
run; each client `subscribe`s with its own cursor. Two TUIs / TUI+browser on one session both stream,
both steer; `interrupt`/`approve` are shared state, `approval_resolved` clears stale modals on all.

## HTTP+SSE transport adapter (`packages/code/src/transport/http/{server,client}.ts`)

The ONLY place HTTP/SSE/`@effect/platform` appears. `server.ts`: `HttpRouter` + `HttpServerResponse.stream`
(NOT `HttpApi` — can't model an open SSE byte stream), served by `BunHttpServer.layer({port, hostname:"127.0.0.1"})`
(`@effect/platform-bun`, already imported `main.ts:7`); bodies via `HttpServerRequest.schemaBodyJson`.
`client.ts`: `HttpClient` (`FetchHttpClient.layer`, `main.ts:6,70`) + an SSE line-parser → `Stream<SeqEvent>`.

Endpoints (map the port 1:1):

| Method + path | → port |
|---|---|
| `GET /health` | `{pid, workspace, version}` (spawn/health poll) |
| `GET /snapshot` | `snapshot()` |
| `GET /sessions` · `POST /sessions` | `listSessions` · `spawn` |
| `GET /sessions/:id/state?since=` | `getState` (DB rebuild) |
| `POST /sessions/:id/{send,interrupt,stop}` | resp. (204) |
| `GET /sessions/:id/events?since=` | `subscribe` — **SSE** |
| `POST /sessions/:id/approve` | `approve` |
| `GET/POST /directive` · `POST /agents|tools/import` · `POST /auth/reload` · `POST /shutdown` | resp. |

**SSE framing:** `id: <seq>\nevent: agent_event\ndata: <AgentEvent JSON>\n\n`; plus
`event: approval_needed`, `event: resync`, `: ping` heartbeat (~15s, `Stream.merge`). Headers:
`text/event-stream`, `no-cache`, `keep-alive`. **Reconnect/replay:** client tracks last `seq`,
reconnects `?since=`/`Last-Event-ID`; server replays ring `seq>since`, then tails the PubSub; if
`since` predates the bounded ring → `event: resync` → client re-fetches `/state`. Ring bounded like
`agentBus.ts:160-161` (`MAX_BOARD`/`MAX_DONE`).

## Daemon + auto-spawn (`packages/code/src/server/daemon.ts`, new `daemon-serve` mode)

Distinct from the legacy cron `daemon` (`packages/code/src/modes/daemon.ts`); add `daemon-serve` to
the mode choice + dispatch (`main.ts:108-115,278-381`). Composes `AppLive` (`main.ts:56-78`, unchanged)
+ in-process Workspace + `transport/http/server` under `BunRuntime.runMain`. Transport referenced only
here (swap = one line). Cron scheduler folds in (ticks the Workspace).

- **Startup:** reconcile stranded `running`; auto-resume pending in-flight turns; load directive +
  persisted approvals.
- **Discovery file** `~/.efferent/daemon-<workspaceHash>.json` (honor `EFFERENT_HOME`, cf.
  `runtime.ts:48`, `schedule.ts:104`): `{port, pid, version, workspace}`; removed on graceful
  shutdown; stale file whose `/health` fails ⇒ treated absent. Hash = resolved workspace dir.
- **Auto-spawn (client):** read discovery → `GET /health`; if absent `Bun.spawn(["--mode","daemon-serve",
  "--cwd",ws], {detached:true, stdio:["ignore","ignore",logFile]})`, poll `/health` w/ backoff, attach.
- **Management:** `efferent daemon {status,stop}` CLI + `:daemon` command (`POST /shutdown` →
  `bus.interruptAll()` like `runtime.ts:351`, remove discovery file, exit). Per-workspace.

## Remote Workspace adapter + TUI rewrite (`packages/code`)

`workspace/remote.ts`: implements `Workspace` over a transport client; `subscribe` → SSE
`Stream<SeqEvent>`; on attach `GET /snapshot` then `GET /sessions/:id/state` and replay `log` through
`makeEventReducer` to rebuild blocks/busy/agentState/pendingApproval, then stream from `cursor`.

TUI (`runtime.ts`): stop building `buildScopeRuntime`/`makeEventHooks`/`makeTuiApproval`/
`makeFleetSupervisor`/directive closure (delete `runtime.ts:102-108,167-198,186-193`); connect-or-spawn
daemon, build remote Workspace, `TuiContext` delegates: `submit`→`send`, `interrupt`→`interrupt`,
`spawnAgent`→`spawn`, `stopAgent`→`stop`, `resolveApproval`→`approve`, `get/setDirective`,
`listFleet`/`liveAgents` from cached `snapshot`. Event pump drains the SSE stream (not the `Queue`);
`makeEventReducer` reused; track `seq`; drop the `flush` sentinel. `nodeLog`/`busy`/`agentState`
become derived from stream+snapshot; run-fiber handle leaves the client. **Views/keys/presentation
unchanged** (the `TuiContext` seam is why). Gate behind a flag during rollout.

## Approval + OAuth round-trips

- **Approval:** fiber parks in the daemon (`Effect.async`, `approval.ts:59`); judge + rules/folders
  stay server-side; parking publishes `approval_needed` (new `AgentEvent` variant) → clients render
  the existing sheet → `POST /approve` resumes + applies scope to the persisted ledger →
  `approval_resolved` clears other clients. Interrupt cleanup (`approval.ts:66-69`) emits resolved.
- **OAuth:** stays **client-side** (browser + loopback callback need the human's machine; TUI
  already runs `login/oauthServer.ts`), writes `auth.json`, then `POST /auth/reload` → daemon
  re-runs `AuthStore.init(cwd)` (`packages/sdk-adapters/src/auth/local.ts:218-228` already reloads
  Refs + recomputes the merge). No browser in the headless daemon.

## Batch modes

`print`/`json` stay **in-process** (a one-shot must not need a daemon) — in-process Workspace or the
current direct `runAgent` path; keep `ensureBatchCredential` (`main.ts:267-276`). `rpc.ts` is
**superseded** by the HTTP API (`agent.send`→`agent.event` ≈ `POST /send` + SSE); keep one release
as a shim, then delete.

## Phasing (each step buildable/testable)

a. **Workspace port + in-process adapter behind the existing TUI** — green, no behavior change. Add
   `entities/AgentEvent.ts` + `ports/Workspace.ts`; `workspace/inProcess.ts` wrapping today's runtime;
   re-point `runtime.ts` to the port locally; pump drains the PubSub. **Includes incremental per-turn
   persistence + in-flight marker** (this pure-refactor window).
b. **HTTP server + smoke client** (`daemon-serve`; tiny client hits `/health`, `/send`, SSE).
c. **Remote adapter + SSE pump** (flip TUI to remote behind `EFFERENT_REMOTE=1`).
d. **Auto-spawn + restorability:** discovery file, detached spawn, health poll, `/snapshot`+`/state`
   rebuild, `?since=` replay + heartbeat + resync, startup reconcile + auto-resume, persisted
   directive + approvals. Flip remote to default.
e. **Approval + OAuth round-trips.**
f. **Multi-session / multi-client seat** (switch the keyboard between sessions; 2 clients/1 session).
g. **Cut over + delete** in-process TUI wiring, client `approval.ts`, `rpc.ts` shim.

Keep red windows short: gate c–d behind the flag; flip default only when attach+reconnect+restore pass.

## Verification (mostly no live model)

- **Fake `LanguageModel` layer** (scripted) drives the full HTTP+SSE path deterministically.
- **Multi-client:** two SSE subscribers on one session both receive events; interrupt/approve from
  one observed by both.
- **SSE reconnect/replay:** unit-test ledger + `subscribe(since)` (drop+resubscribe; old `since`→resync).
- **Restorability + in-flight resume:** `daemon-serve` + fake model, send multi-turn, **kill daemon
  mid-turn**, restart; assert `/snapshot`+`/state` rebuild, stranded `running` reconciled, pending
  turn auto-resumes, directive + session approvals survived.
- **Auto-spawn/attach/reattach:** spawn, attach, drop client, reattach, assert rebuild + discovery
  lifecycle.
- **Approval round-trip:** fake bash tool → `approval_needed` → `POST /approve` → resume; 2nd client
  sees `approval_resolved`.
- **Live-only (opt-in `EFFERENT_LIVE`):** token/compaction realism, Anthropic PKCE, provider streaming.

## Critical files

- **New:** `packages/sdk-core/src/entities/AgentEvent.ts` (Schema union, moved); `…/ports/Workspace.ts`
  (port + protocol Schemas); `packages/code/src/workspace/{inProcess,remote}.ts` (remote =
  transport-generic); `packages/code/src/transport/http/{server,client}.ts` (the ONLY HTTP/SSE code);
  `packages/code/src/server/daemon.ts`.
- **Reworked:** `packages/code/src/modes/daemon.ts` (→ `daemon-serve` + lifecycle + reconcile +
  auto-resume); `packages/code/src/cli/runtime.ts` (re-point to Workspace; SSE pump);
  `packages/sdk-core/src/usecases/{runAgent,agentLoop}.ts` + `buildScopeRuntime.ts` (incremental
  persistence + in-flight marker); `packages/code/src/cli/approval.ts` (ledger → server);
  `packages/code/src/main.ts` (mode + auto-spawn).
- **Reused verbatim:** `events.ts` (AgentEvent), `eventPump.ts` (`makeEventReducer`),
  `presentation/historyProjection.ts` (`projectHistory`), the stores, `login/oauthServer.ts`.
- **DB migrations (`packages/adapters/src/database/`):** per-turn message append; an in-flight/pending
  marker; a `directives` row; a persisted session-approval set.

## Biggest risks → de-risking

- **SSE reconnect/replay correctness** (highest): monotonic `seq` + bounded ring + `?since=`/
  `Last-Event-ID` + `resync` + `/state` snapshot. Land ledger+replay unit tests in step (b) first.
- **Approval across the boundary:** keep ALL judge/rules logic server-side; only trigger (event) +
  resume (POST) cross; `approval_resolved` defeats stale modals.
- **OAuth co-location:** login client-side + `/auth/reload` (the AuthStore Ref-reload already exists).
- **Stale nodes:** reconcile-on-start loop; ship in (d).
- **In-flight auto-resume idempotency:** incremental persistence + retry cap.
- **TUI rewrite size:** contained by the `TuiContext` seam + reusing `makeEventReducer`/
  `projectHistory` verbatim; the biggest chunk (moving `submit.ts` busy/queue/mailbox server-side) is
  done as the pure refactor in step (a), before the wire exists.

## OPSEC + process

Branch `feat/agent-daemon` (or continue `feat/agent-roles-fleet`). Commits authored
`Xand Reed <xandreed@proton.me>`; messages end `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
Commit per phase; push only when asked. After it works, add a live `website/` concept page
("daemon / attach", tmux-style split) + update the runtime concept.

---

# Control plane (built on top — the daemon as observable infra)

The daemon split landed invisible plumbing. The **control plane** makes it a deliberate, observable
infrastructure layer. The mental model is k8s: **daemon = cluster**, **fleet = deployment** (a root
coordinator conversation + its sub-agent subtree), **agent = pod** (a context-tree node), **coder
TUI / web chat = on-demand clients** you attach to a fleet's coordinator. Several clients share one
daemon and can each attach to a different fleet. Built as 5 phases (all on `wip2`, 620 tests green):

1. **Multi-fleet adapter + per-fleet model pinning + restorability** (`d394b49`). `inProcess.ts`
   hosts **N fleets** over one shared `scopeRuntime`/bus/ledger (the blackboard + folder-locks MUST
   be workspace-wide); only per-fleet run state (busy/fiber/queue, first-exchange, pinned model) is
   per-fleet. Fleets are seeded from `deps.roots` and grown by `createFleet`. **Per-fleet model
   pinning** is the config-safety fix: `runAgent(modelOverride)` → `RunContext.modelOverride` (the
   router already prefers it) + a `conversations.model` column (pg `0012` / sqlite `0008`); each fleet
   pins its chat model (default `settings.model`), so a global-default change never touches a running
   fleet. New port methods `createFleet`/`setFleetModel`; `interrupt(fleetRoot)` cancels only that
   fleet's subtree (BFS over `bus.childrenOf`, not `interruptAll`). The daemon seeds fleets from
   `listByWorkspace`, reconciles stranded `running` nodes across ALL fleets, and auto-resumes every
   pending fleet.
2. **Self-contained in-daemon metrics** (`c5278fd`). `workspace/metrics.ts:readWorkspaceMetrics`
   folds `Metric.snapshot` (the process-global registry, populated by every `Metric.update`
   regardless of OTLP) by name + tags into per-role tokens + cost + RED, plus running/done agent
   counts + a 60s messages-per-minute rate from the bus. `metrics()` port method +
   `RoleTokens`/`WorkspaceMetrics` Schemas + `GET /metrics`. `METRIC_NAMES` is the single source the
   recorder + reader share. No Grafana needed.
3. **Messages-flying firehose** (`24869e3`). A `board_note` `AgentEvent` variant +
   `makeAgentBus(onEvent?)`: blackboard posts, inbox messages, and completion notes all emit a
   `board_note` through the sink the adapter wires to its ledger `publish` — so the dashboard's
   "messages flying" stream IS the SSE stream (replay for free). `messages(limit?)` + `FleetMessage`
   seed a freshly-attached dashboard before it tails.
4. **k9s-style control dashboard TUI** (`322c65a`, `cli/dashboard/`). A thin remote client (sibling of
   `remoteRuntime`): a metrics strip, the fleets → agents tree (git-graph rails + fold), and the
   messages stream, with operator keys (`↵`/`a` attach — copies `efferent --fleet <id>` via OSC52, `n`
   new fleet, `s` stop agent, `i` interrupt fleet, `D` shutdown, `q` quit). Pure `dashboardView.ts`
   model is unit-tested; the OpenTUI mount is smoke-tested via `efferent daemon`.
5. **`daemon` command group + config-through-API + `--fleet`** (`2a920ad`). `efferent daemon`
   boots-or-attaches + opens the dashboard (`-v`/`--logs` tails the daemon log); `daemon serve` is the
   headless server (today's `--mode daemon-serve`, dual-accepted as the auto-spawn target); `daemon
   status`/`stop`. `getSettings`/`updateSettings(SettingsPatch)` let a client configure the daemon
   over the API (the daemon owns + persists its config — no file-editing behind its back);
   `updateSettings({model})` changes only the DEFAULT new fleets inherit. `efferent --fleet <id>` pins
   which coordinator the coder attaches to.

**Honest limits / deferred:** the in-flight marker is per fleet-root, so a mid-flight **sub-agent**
(pod) is reconciled to `error` (partial work kept) rather than individually re-driven — per-node
markers are a noted follow-on. Per-fleet **directive** persistence is deferred (directive stays a
workspace-wide in-memory Ref). Full in-dashboard **onboarding** is deferred — the dashboard shows a
no-credential banner and you onboard via the coder (`efferent` → `:login`).
