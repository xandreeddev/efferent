# @xandreed/plugin-sessions

Core's `Sessions` port over the host's `SessionLog`: one event log per session, one open turn at a time (`BeginTurn`'s direct User, Queued user input, Inbox notices or Task, told apart by `Match.valueTags` in `askedOf`), turns owned by a lease or by the process that began them, the inbox, forks, resumes, `TurnActivity` (the turns this instance holds open or is beginning) and `TurnShutdown` (how it stops), plus owner-observed `WaitingInput`. The host admits every turn through `TurnAdmission`. Node 24 and Bun; layer `plugin-sessions` in `foundry.config.ts` (imports core only, no `node:`).

## Rules

- Change the head's `sessions` state only in a guarded commit (`guarded`: compare-and-swap on the revision, planned again after a conflict) with the events that justify it; no backend reads that state.
- Stamp the state with core's `STORED_FORMAT` in every commit that writes it (`withFormat`), and refuse a session a newer release stamped before planning any write or turn (`refuseNewer`, `session.version`); never refuse a read. A change to `SessionsState` is a stored-shape change: it bumps `STORED_FORMAT` (skill `change-event`).
- Fail with `SessionLogError` only for the store (the log's own, or stored data that does not decode: `session.state`, `session.decode`, its `cause` kept); `guarded` gives up as `SessionContended` after `retries` conflicts; a value of the plugin's own that does not encode, or an answer the log's contract rules out, is a defect (`Effect.orDie`, `Effect.die`).
- Read a stored record's fields through core's `readStored` (`turn.ended`, `inbox.queued`), and look a turn up by its key or run through `readStoredKeys`, which decodes the keys alone, never the message and its images; never read `event.data.<field>` unchecked. A row that does not decode fails with `session.decode`.
- Pass a known snapshot or fork ceiling as `SessionReadQuery.through` before reading event data. Filtering after a read is too late for a decorating store that hydrates blobs. Keep the final sequence filter as defense for custom backends, and never compare sequence numbers across sessions.
- `SessionsState.memorySnapshot`, when present, identifies a `memory.snapshot` publication in that head's own session. Every state transition preserves it. The writer derives it from the final stamped draft offset inside each CAS attempt, before omitting unchanged state: the snapshot and pointer commit together, including after a rebase. A snapshot allocates no memory entry id.
- `TurnWriter.memorySnapshot` reads a pointer before its own `turn.started`, or an ancestor pointer within that ancestor's fork ceiling. Read only the exact pointed row with `after`, `through`, kind and limit; an ineligible future pointer returns None before fetching its payload or media. A selected wrong-session pointer, missing/wrong row or invalid snapshot data fails with `SessionLogError` `session.decode`, its cause retained. An own overall head rejected during begin retains the existing `session.state` behavior. The SDK validates actual anchor/frontier memory rows and retained contents; this adapter validates their authorized lineage order. Existing full `history` and fresh durable `snapshot` reads retain their meanings.
- Write a turn's events only through its writer (`makeTurnWriter`): one fiber in queue order, consecutive appends in one commit, the framework's reserved kinds refused unless marked (`ReservedKind`). The closing drafts a turn holds (`closing`, its reply) are stored only by the end's own commit, right before `turn.ended`: never by a flush, kept when an end is refused by the store, dropped by a close from elsewhere.
- Keep the writer's state in its one phase (`WriterPhase`: open, ending, failed, closed, ended; open and ending carry the closing drafts): move it only by the pure transitions of `src/turn-writer.entity.functions.ts` under `Ref.modify`, then run what the transition planned (queue an item, commit the end, settle the callers). Never a `SynchronizedRef`: the consumer fiber latches failures while an admitter holds the admission permit, blocked on a full queue; the `admission` semaphore only orders admissions.
- Raise the writer's failures as `TurnError`'s tags, never as a `HarnessError` of their codes: `TurnClosed` with its reason (`ended` for its own end or a closed scope), `ReservedKind`, `SessionContended`, the log's own `SessionLogError`; a `HarnessError` only for the writer's own state (`session.encode`, `session.state`) and a write that died (`session.defect`), with its `cause`. Match them with `Effect.catchTag`, never by code.
- Judge an open turn by its own record (a lease end, or none and its holder process) through `isHeld`, never by the reading instance's ownership; a begin with `takeOver` (the host's word that the holder is gone) closes a turn still held in its opening commit (`reaped`), with `turn.takeover` and no attempt counted, and closes this instance's own writer of it at once.
- Refuse a busy begin, never replace the open turn: `SessionBusy`, `TurnDuplicate`, `KeyConflict`, `RunIdReused`, `NotResumable`, `NothingPending`. Save user work explicitly through `enqueue`; it does not begin a turn.
- Normalize queued messages before storage. One input id names its normalized message, delivery and source forever: identical enqueue returns false even after completion; another payload or an id used by a notice is `InputConflict`. Keep the payload only in `inbox.queued.input` (legacy `content` empty), with its delivery marker in the head; never duplicate attachment bytes in the head.
- A Queued begin claims exactly its named input in the opening CAS, with origin user, its exact message and no claimed notices. Resolve its actual initial or retry key before admission, then recheck its pending claim in the opening plan. Carry full provenance on `AdmittedTurn.input`, only its id on `turn.started.input` and `TurnToAdmit.input`; include identity in the key fingerprint.
- Reclaim a queued input when an ordinary User begin resumes its root, in the same opening commit. A successful resume acknowledges it once; a failed resume returns it. A manually resumed cancellation keeps provenance without recreating an acknowledged slot.
- Keep `Inbox` begins and `admitted.claimed` notice-only. `drain` selects `all`, `inputs` or `notices`; queued inputs run singly in enqueue order, with an untaken steer still eligible for its own queued user turn. All selects the oldest waiting kind, and an Inbox then takes the notice batch.
- `TurnWriter.steers` reads fresh pending steers in queue order, including other instances' commits, without recording an attempt. Exclude next input, notices and claimed initial input. `take(entries)` refreshes/rebases before eligibility checks; a stale selection returns false without a commit or attempt.
- A successful take validates one exact user `Message` per distinct input id, with this turn/run and fresh entry ids; one CAS stores every message, its `inbox.taken` receipt and slot removal. Keep messages and queue consumption in one commit, and never call memory or flush the writer from its queued decision. A taken steer is acknowledged by that durable message across failed turns; the receipt's outer turn anchors later `TurnDuplicate`, before run-id reuse checks, without inventing a turn.started input link.
- Count notice attempts by the existing write/interruption rules; drop a notice once `inbox.attempts` turns took it and failed. Untaken queued input is never dropped by attempts: failed, partial and interrupted turns return it; completion, waiting for an answer or explicit cancellation acknowledges the input claimed by that turn. Preserve an early answer and the absent delivery marker of legacy notice slots.
- Keep `TurnActivity` exact: a begin counts from the request until its writer is handed over, then the turn until the writer's scope closes (`awaitIdle` relies on it).
- Close an open turn from outside through `closeOpen` (a cancel, a shutdown): one guarded commit that reaps a turn nobody holds instead, else stores its `turn.ended`, then closes this instance's writer of it with the same reason.
- Run a turn's time limit (the begin's `timeLimitMs`, else `turns.timeLimitMs`) as a fiber in the turn's scope, from when its writer is handed over: past it, close the turn as interrupted with `turn.time-limit`, an attempt counted, its writer's `TurnClosed` `timed-out` (`closeForTimeLimit`); the scope's close stops the timer.
- Stop for a shutdown in one phase (`stopping`: running, refusing, interrupting): once refusing, refuse every begin before the host's admission and again inside its opening plan (`shutdownRefusal`), never a delivery; once interrupting, close every turn this instance holds, and any begin whose writer is handed over after, as interrupted with `turn.shutdown` and no attempt counted (`closeForShutdown`), its writer closed even when the store refused the end.
- A keep-alive is queued in order with the turn's writes: keep one `write` or `transact` shorter than the lease.
- Signal `changes` through one hub per followed session, `PubSub.sliding(1)` held in an `RcMap` (released with its last follower): a commit wakes only its own session's followers, and a follower that does not pull holds one signal. Never `dropping` (it loses the last signal) nor a `SubscriptionRef` (it signals a follower on subscribing, before any commit).
- Trace each `Sessions` call but `changes` as `sessions.<op>` (`Effect.fn`; the `onSession` pipeable puts `sessionAttributes` on its span and its logs), each writer commit as `turn_writer.commit` under the span of the call that queued it (`underCaller`: the writer's fiber was forked under the begin), and the writer's `flush` and `end` as `turn_writer.flush` and `turn_writer.end`, all with `turnAttributes`; the writer's fibers carry the turn's ids on their spans and logs. A log line names no id: the ids are its annotations. Trace nothing per append or per `write`.
- Import no `node:` module: `processLiveness` reaches `node:os` through `process.getBuiltinModule` and works without a process.
- Change behaviour by adding the check to core's `sessionsConformance` first, with a careless instance in `src/sessions.conformance.test.ts` that it catches.

- `Sessions.waiting` broadcasts one initial signal after subscribing, then coalesced local commits through a scoped sliding-one hub. Keep per-session `changes` commit-only. Both hubs wake after a writer commit.
- `WaitingInput` observes only successfully owner-checked addresses, refreshes their unclaimed delivery-marked slots, excludes notices and forgets removed sessions. Storage failures stay typed; cached knowledge is infallible and never resets on a failed read. Its idle wait polls foreign commits too (`inbox.pollIntervalMs`). No stored state is added for activity.
- `InboxDrainLive` is an optional host-composed layer requiring Sessions and InboxRunner, with explicit owners, fixed scoped workers, per-session serialization, fair scheduling and bounded backoff. Wakes never reset retry deadlines; startup takeover authority is consumed once. Preserve input after partial/failed/interrupted attempts and intentionally cancelled resume branches.

## Public surface

- `InboxDrainLive(options)`, `InboxDrainConfig`, `InboxDrainOptions`, `inboxDrainDefaults`; no owner or takeover authority is inferred.
- `sessionsPlugin` (also the default export) and `SessionsPluginLive` (its `.live` layer); `SessionsLive(config, { liveness })` for hosts that compose layers; `processLiveness` (type `ProcessLiveness`).
- Core contracts implemented here: `Sessions.enqueue`, `BeginTurn.Queued`, `QueuedInput`, `InputDelivery`, `TurnWriter.steers` and `take`; the core entry exports those schemas and `InputConflict`. `drain.take` defaults to all; reaction-only hosts select notices.
- Config: `SessionsConfig`, `sessionsDefaults` (a 60 s lease, a keep-alive every 20 s, a turn time limit of 6 hours), `Ownership`; `HolderProcess`, where a process-owned turn's holder runs (what `ProcessLiveness.current` returns). The state the plugin keeps in the session head (`SessionsState`, `HeldTurn`, `InboxSlot`) is its own and stays inside the package.

The root names each export, and `quality/exports-have-consumers` checks each one: other packages' tests, the scripts and the docs import `sessionsPlugin`, `SessionsPluginLive`, `SessionsLive`, `SessionsConfig`, `sessionsDefaults` and `ProcessLiveness`, and the rest are tagged `@public` at their declarations (`sessionsPlugin`'s tag covers the default export).

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `sessionsPlugin` | `@xandreed/plugin-sessions` | runtime | `efferent/Sessions`, `efferent/TurnActivity`, `@xandreed/core/TurnShutdown`, `@xandreed/core/WaitingInput` | none | `efferent/SessionLog`, `efferent/TurnAdmission` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| An inbox turn's user message: the claimed items' contents, in delivery order, joined by a blank line | `src/sessions.adapter.ts:557` | exact, `src/sessions.adapter.test.ts:1332` (one item, `:1162`) |
| `(inbox item <id>)`, for an item stored without content | `src/sessions.adapter.ts:441` | exact, `src/sessions.adapter.test.ts:1314` |
| Default user message when the inbox drainer resumes interrupted work: `Continue.` (`resumeMessageOf`) | `src/inbox-drain.entity.functions.ts:17` | exact, `src/inbox-drain.entity.functions.test.ts:16` |
| Invalid selected memory snapshot message, also used for an invalid snapshot publication | `src/memory-snapshot.adapter.ts:10` | exact, `src/memory-snapshot.adapter.test.ts:148` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/inbox-drain.adapter.ts` | scoped owner discovery, coalesced wakes, fixed workers and DrainActivity |
| `src/inbox-drain.entity.ts`, `src/inbox-drain.entity.functions.ts` | checked host policy, journal projections and pure scheduling transitions |
| `src/plugin.adapter.ts` | `sessionsPlugin`, `SessionsPluginLive` |
| `src/sessions.adapter.ts` | `SessionsLive`: create, fork, begin, enqueue, deliver, selected drains, cancel, remove, reaping, change signals, `TurnActivity`, `TurnShutdown` |
| `src/turn-writer.adapter.ts` | the open turn's writer: queued, batched commits, lease renewal and keep-alive |
| `src/memory-snapshot.adapter.ts` | checked snapshot publication pointers and exact eligible pointed-row reads across lineage |
| `src/turn-writer.entity.ts` | the writer's phase (`WriterPhase`, with the closing drafts held) and how an end begins (`EndStep`) |
| `src/turn-writer.entity.functions.ts` | the writer's transitions: admit, hold the closing drafts, begin, plan, settle and withdraw an end, latch, close, the scope's own ending |
| `src/sessions-state.entity.ts` | config, ownership and the state kept in the head |
| `src/sessions-state.entity.functions.ts` | state from a head, `isHeld`, `closedState`, `viewOf`, titles |
| `src/process-liveness.adapter.ts` | `processLiveness`: host, pid and start time, `kill(pid, 0)` |
| `src/index.ts` | the public exports |

## Tests

- `src/memory-snapshot.adapter.test.ts`: atomic row/pointer publication with unchanged state, assigned offsets after CAS conflict, lifecycle and lease preservation, nested fork sequence overlap, future-media exclusion, selected corruption, invalid frontier, lost ACK identity and interrupted ACK waiters. The shipped Sessions kit checks the optional advertised snapshot capability and a careless reader that always returns None.
- `src/waiting-input.adapter.test.ts`: honest storage failures, cached shutdown backlog, raw reads with invalid state, and interrupted-ACK wakes for enqueue/create/fork/remove.
- `src/inbox-drain.adapter.test.ts` and `.entity.functions.test.ts`: discovery, concurrency, backoff, startup takeover, shutdown and cancellation. The shared `scripts/inbox-restart-consumer.fixture.mjs` runs real killed-tool and killed-take recovery on source Bun and packed Node/Bun.
- `src/sessions.adapter.test.ts`: one turn at a time, leases, activity, cancel and removal, check then append, contention and a broken log, the inbox, resuming, forks, admission, and the spans and log annotations, over the in-memory log.
- `src/turn-writer.entity.functions.test.ts`: the writer's transitions, as tables, phase by phase. `src/sessions-state.entity.functions.test.ts` distinguishes bounded notice attempts from retained queued input and cancellation acknowledgments.
- `src/durable-steering.adapter.test.ts`: read-only probes and false takes, CAS against concurrent enqueues/cancellation, lost take acknowledgments, reused ids and newer-format fencing.
- `src/sessions.conformance.test.ts`: core's `sessionsConformance` over the in-memory log, and the kit's self-tests (careless instances that must fail the named checks, a writer raising its refusals as `HarnessError` codes and one storing its closing drafts at once among them).
- `packages/sdk/src/sessions-begin-trace.test.ts`: under a begin traced as `Agent.turn` traces it (the sdk's `traceTurnBegin`), the begin holds only its own work and the writer's commits nest under the calls that asked for them, with the turn's ids.
- `packages/sdk/src/queued-input.journey.test.ts`: normalized queued attachments through a prebegun writer and real agent, plus an interrupted queued root reclaimed by an explicit user resume.
- Elsewhere: plugin-session-sqlite runs the same kit and its crash tests over SQLite; the sdk journeys and golden (`packages/sdk/src/resume.journey.test.ts`, `agent.golden.test.ts`) compose `SessionsLive`; `verify:packages` runs the kit on Node over the packed package.
- Run: `bun test packages/plugin-sessions packages/plugin-session-sqlite`.

See the root AGENTS.md for the enforced rules and the definition of done.
