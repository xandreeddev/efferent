# @xandreed/plugin-sessions

Core's `Sessions` port over the host's `SessionLog`: one event log per session, one open turn at a time (a user's, the inbox's or a background task's, `BeginTurn`'s three kinds, told apart once by `Match.valueTags` in `openTurn`), turns owned by a lease or by the process that began them, the inbox, forks, resumes, and `TurnActivity` (the turns this instance holds open or is beginning). The host admits every turn through `TurnAdmission`. Node 24 and Bun; layer `plugin-sessions` in `foundry.config.ts` (imports core only, no `node:`).

## Rules

- Change the head's `sessions` state only in a guarded commit (`guarded`: compare-and-swap on the revision, planned again after a conflict) with the events that justify it; no backend reads that state.
- Fail with `SessionLogError` only for the store (the log's own, or stored data that does not decode: `session.state`, `session.decode`, its `cause` kept); `guarded` gives up as `SessionContended` after `retries` conflicts; a value of the plugin's own that does not encode, or an answer the log's contract rules out, is a defect (`Effect.orDie`, `Effect.die`).
- Read a stored record's fields through core's `readStored` (`turn.ended`, `inbox.queued`), and look a turn up by its key or run through `readStoredKeys`, which decodes the keys alone, never the message and its images; never read `event.data.<field>` unchecked. A row that does not decode fails with `session.decode`.
- Write a turn's events only through its writer (`makeTurnWriter`): one fiber in queue order, consecutive appends in one commit, the framework's reserved kinds refused unless marked (`ReservedKind`). The closing drafts a turn holds (`closing`, its reply) are stored only by the end's own commit, right before `turn.ended`: never by a flush, kept when an end is refused by the store, dropped by a close from elsewhere.
- Keep the writer's state in its one phase (`WriterPhase`: open, ending, failed, closed, ended; open and ending carry the closing drafts): move it only by the pure transitions of `src/turn-writer.entity.functions.ts` under `Ref.modify`, then run what the transition planned (queue an item, commit the end, settle the callers). Never a `SynchronizedRef`: the consumer fiber latches failures while an admitter holds the admission permit, blocked on a full queue; the `admission` semaphore only orders admissions.
- Raise the writer's failures as `TurnError`'s tags, never as a `HarnessError` of their codes: `TurnClosed` with its reason (`ended` for its own end or a closed scope), `ReservedKind`, `SessionContended`, the log's own `SessionLogError`; a `HarnessError` only for the writer's own state (`session.encode`, `session.state`) and a write that died (`session.defect`), with its `cause`. Match them with `Effect.catchTag`, never by code.
- Judge an open turn by its own record (a lease end, or none and its holder process) through `isHeld`, never by the reading instance's ownership.
- Refuse a begin, never queue or replace one: `SessionBusy`, `TurnDuplicate`, `KeyConflict`, `RunIdReused`, `NotResumable`, `NothingPending`.
- Count an inbox attempt only for a turn that wrote something; drop an item once `inbox.attempts` turns took it and failed.
- Keep `TurnActivity` exact: a begin counts from the request until its writer is handed over, then the turn until the writer's scope closes (`awaitIdle` relies on it).
- A keep-alive is queued in order with the turn's writes: keep one `write` or `transact` shorter than the lease.
- Trace each `Sessions` call but `changes` as `sessions.<op>` (`Effect.fn`; the `onSession` pipeable puts `sessionAttributes` on its span and its logs), each writer commit as `turn_writer.commit` under the span of the call that queued it (`underCaller`: the writer's fiber was forked under the begin), and the writer's `flush` and `end` as `turn_writer.flush` and `turn_writer.end`, all with `turnAttributes`; the writer's fibers carry the turn's ids on their spans and logs. A log line names no id: the ids are its annotations. Trace nothing per append or per `write`.
- Import no `node:` module: `processLiveness` reaches `node:os` through `process.getBuiltinModule` and works without a process.
- Change behaviour by adding the check to core's `sessionsConformance` first, with a careless instance in `src/sessions.conformance.test.ts` that it catches.

## Public surface

- `sessionsPlugin` (also the default export) and `SessionsPluginLive` (its `.live` layer); `SessionsLive(config, { liveness })` for hosts that compose layers; `processLiveness` (type `ProcessLiveness`).
- Config and stored state: `SessionsConfig`, `sessionsDefaults` (a 60 s lease, a keep-alive every 20 s), `Ownership`, `SessionsState`, `HeldTurn`, `HolderProcess`, `InboxSlot`.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `sessionsPlugin` | `@xandreed/plugin-sessions` | runtime | `efferent/Sessions`, `efferent/TurnActivity` | none | `efferent/SessionLog`, `efferent/TurnAdmission` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| An inbox turn's user message: the claimed items' contents, joined by a blank line | `src/sessions.adapter.ts:407` | exact for one item, `src/sessions.adapter.test.ts:1035`; the join unpinned |
| `(inbox item <id>)`, for an item stored without content | `src/sessions.adapter.ts:313` | exact, `src/sessions.adapter.test.ts:1187` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | `sessionsPlugin`, `SessionsPluginLive` |
| `src/sessions.adapter.ts` | `SessionsLive`: create, fork, begin, deliver, drain, cancel, remove, reaping, `TurnActivity` |
| `src/turn-writer.adapter.ts` | the open turn's writer: queued, batched commits, lease renewal and keep-alive |
| `src/turn-writer.entity.ts` | the writer's phase (`WriterPhase`, with the closing drafts held) and how an end begins (`EndStep`) |
| `src/turn-writer.entity.functions.ts` | the writer's transitions: admit, hold the closing drafts, begin, plan, settle and withdraw an end, latch, close, the scope's own ending |
| `src/sessions-state.entity.ts` | config, ownership and the state kept in the head |
| `src/sessions-state.entity.functions.ts` | state from a head, `isHeld`, `closedState`, `viewOf`, titles |
| `src/process-liveness.adapter.ts` | `processLiveness`: host, pid and start time, `kill(pid, 0)` |
| `src/index.ts` | the public exports |

## Tests

- `src/sessions.adapter.test.ts`: one turn at a time, leases, activity, cancel and removal, check then append, contention and a broken log, the inbox, resuming, forks, admission, and the spans and log annotations, over the in-memory log.
- `src/turn-writer.entity.functions.test.ts`: the writer's transitions, as tables, phase by phase.
- `src/sessions.conformance.test.ts`: core's `sessionsConformance` over the in-memory log, and the kit's self-tests (careless instances that must fail the named checks, a writer raising its refusals as `HarnessError` codes and one storing its closing drafts at once among them).
- Elsewhere: plugin-session-sqlite runs the same kit and its crash tests over SQLite; the sdk journeys and golden (`packages/sdk/src/resume.journey.test.ts`, `agent.golden.test.ts`) compose `SessionsLive`; `verify:packages` runs the kit on Node over the packed package.
- Run: `bun test packages/plugin-sessions packages/plugin-session-sqlite`.

See the root AGENTS.md for the enforced rules and the definition of done.
