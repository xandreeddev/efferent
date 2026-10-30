---
title: Conformance kits
description: The port contracts as runnable checks, to run against your own adapter in any test runner.
---

# Conformance kits

A port says what its methods take and return; a conformance kit says what an
implementation must do. `@xandreed/core/conformance` ships each contract as a
list of checks (the models plugin's credential and settings stores' from
`@xandreed/core/models`), so a host that writes its own session store, sessions backend, task
runner, tasks backend, tool registry, memory strategy, step loop, turn
composition, file system, shell or model credential and settings store can
prove it behaves like the first-party ones (`@xandreed/plugin-workspace`'s
local file system and shell pass the file-system and shell kits on Bun and
Node; `@xandreed/plugin-sessions`, `@xandreed/plugin-tasks` and
`@xandreed/plugin-tool-discovery` pass the sessions, task and registry kits).
`@xandreed/plugin-render` does the same for render surfaces, feeds and
transports (see [render kits](#render-kits)).

## The kits

| Kit | Checks | Run against |
| --- | --- | --- |
| `sessionLogConformance(log)` | dense sequence numbers, one revision per commit, compare-and-swap, the `notAfter` clock check, JSON kept by value (an `undefined` field dropped, not refused), an event as large as a message's images at their limit (`MEDIA_LIMITS.requestChars` base64 characters), reads by position and kind, listing order, children and their removal | a `SessionLog` |
| `sessionLogRecoveryConformance(subject)` | reopening, several open handles, interrupted commits, a handle whose scope never closed, the exact `notAfter` boundary | a way to open a `SessionLog` |
| `sessionsConformance(subject)` | create, get, list and fork; one open turn per session on every instance and one winner of a race; key retries (`TurnDuplicate`, whatever the `meta`) and `KeyConflict`; a reused run id (`RunIdReused`) opening nothing; `meta` stored and admitted; every `NotResumable` reason; a task's turn (origin `task`, its `TaskRef`) admitted, stored, keyed and never resumed; `AttachmentRejected` and `NothingPending` opening nothing; the writer's order and endings; `transact` and the reserved kinds, refused to a turn's writer too unless the framework's turn wrote them; cancel and removal, and a turn nobody holds reaped alike by a cancel or a delivery; the inbox; a write renewing a lease, a lease that ran out and a dead process holder reaped; a turn judged as it was taken, not by the reader's ownership; `TurnActivity`, when the instance has one, agreeing with what is open | a way to open `Sessions` instances over one store, and to move its clock |
| `taskRunnerConformance(make, { interruptsOnClose? })` | `run` hands the work over and returns, the work runs once, outlives its caller, is told a deadline not in the past and runs without the caller's services; `TaskActivity` counts it from the hand-over; closing the runner's scope interrupts it | a way to make a `TaskRunner` (and its `TaskActivity`) |
| `tasksConformance(make)` | a task runs as one turn of a child session (spawn empty, fork with the parent's closed turns), its result reaches the parent's inbox once and the parent reacts once, after the turn in flight; `task.started` once per task, a second start runs nothing, the same id with other instructions `TaskConflict` and an id naming another session `SessionExists`; the child's turn a task's (origin `task`); a failed task says why; cancel; the executor's turns run with the backend's `Tasks` (the child finds its task running, the reaction finds it finished); no task starts tasks, a host's fork may; `reconcile` starting a task that never ran and delivering a result whose delivery was lost | a way to build `Sessions` and `Tasks` over the kit's runner and executor |
| `toolRegistryConformance(make)` | the catalog, activation (always-on, on demand, unknown, ungranted, only growing), concurrent `load_skill` calls each leaving their tools active, activated once, one invocation id per call minted before the checks, `CurrentToolInvocation` and the opener's services in the handler, the services a tool declares (`requires.missing` when the run lacks one, the opener's when it has them), events published on the run's bus only (never written to the journal by the registry), `PermissionGrants`, a `tool.refused` for each reason (`inactive`, `forbidden`, `denied`, `call-limit`, `tool-call-limit`) | a way to build a `ToolRegistry` over the kit's capabilities |
| `memoryConformance(memory, services)` | own entry ids, a log that reads back exactly after a reopen, views and artifacts kept, a pure build, the step context only when asked and only its own run's, append-only maintenance, a message's images through a reopen (the current turn's built as image parts, an earlier turn's as image parts or label lines), a tool result's images stored once and the current turn's built as the result's images | a memory strategy |
| `stepLoopConformance(loop)` | per-step event order, each step ended once with nothing recorded under it after its `step.ended` (correctives, nudges and steers are the next step's), nothing recorded under a step that never starts (the step cap or a complete verdict ending the run with a corrective or a nudge due), a step whose completion fails afterwards still `completed`, a malformed step ended `malformed` with no `completion.evaluated`, validation before dispatch, planned batches, forced tool choices, no call after completion, the run's usage (the sum of its `assistant.message` usage), the step cap, each of `StepLoopReferences` provided whatever the caller's (the request's `captureTraceContent` reaching its model calls as `CurrentTraceContent`, its `cacheKey` and `callPolicy` reaching its dispatch checks and model calls as `CurrentPromptCacheKey` and `CurrentModelCallPolicy`, `CurrentEmptyResponseTolerance` false until the run has executed a tool call and true after, the current step reaching its tool handlers and model calls as `CurrentAgentStep`, its step events numbered alike), a request refused over an image planned again and sent once more when `onMediaRejected` answers true (failing when it answers false), a streamed step's reasoning reaching the next request with its provider metadata (signed and redacted thinking) as a non-streamed one's does, planned and id-less tool calls given ids distinct across two runs of a turn and two turns, with the request's run ordinal on every step event | a `StepLoop` |
| `turnConformance(runner, services)` | the writer first, the message before the matcher's history, the reply and the end exactly once, tasks joined before the reply, a model-driven turn's usage equal to its stored `step.usage` records (`turnUsageOf`), the user's attachments stored with the turn and reaching the first request as image parts, two runs of one turn each rebuilding their own request from the stored events (the second never with the first's step context), the host layer seeing only earlier turns, a turn it begins returning the inbox items left waiting (`pending`), a turn that cannot begin failing with the refusal itself (`SessionBusy`) and running nothing, an interrupted turn ending at once while a background reaction to its reply is stuck, a background reaction publishing past its queue's size not hanging the turn | a turn composition |
| `fileSystemConformance(subject)` | round trips, `createParents`, byte ranges, append, rename, `stat` and links, sorted listings, `glob`, `mkdir`, `realPath`, the `remove` rules, the `reason` of every failure | a way to open a `FileSystem` over an empty directory |
| `bashConformance(subject)` | exit codes as results, separate streams, output before exit, stdin, the inherited-environment allowlist, timeouts and interrupts that kill the process group, `cwd`, signals, UTF-8 | a way to open a `Bash` adapter |
| `authStoreConformance(store, { refresh?, corrupt? })` | an absent provider, API key, `local` and OAuth credentials read back and resolve as they should (the key `Redacted`), an expired token the store cannot refresh fails with an `AuthError` naming the provider and never returns the stale token, `set` replaces, `remove` deletes everywhere and is a no-op for an absent provider, providers are isolated; with `refresh`, concurrent calls on one expired token send one token request and a `remove` during it sticks; with `corrupt`, damaged backing data fails every call with `auth.corrupt` | an `AuthStore` |
| `settingsStoreConformance(store, { writable, corrupt? })` | `load` is stable; writable: each role and key reads back typed, `None` clears back to the value before the set, a value that does not parse (through `set` or `setRole`) fails with a `SettingsError` and changes nothing; read-only: every write is refused and changes nothing; with `corrupt`, damaged backing data fails `load` and every write with `settings.corrupt` | a `SettingsStore` |
| `modelCatalogConformance(catalog, { includes? })` | entries decode, each selection is `"<provider>:<modelId>"` of its own provider, no selection twice, two lists agree, the expected selections are listed | a `ModelCatalog` |

Every core kit returns `ReadonlyArray<ConformanceCheck>`. A check has a `name` and
a `run` effect that succeeds, or fails with a `ConformanceFailure` whose
`check` names the broken part of the contract and whose `message` says what
happened. The session log, Sessions and Tasks kits use fresh session ids and
owners in every check, so they can run against a shared database; the
TaskRunner and ToolRegistry kits build what they check afresh for each
check. The AuthStore kit uses fresh
provider ids (`conformance-<uuid>`) and removes them when a check ends. The
SettingsStore kit writes the store's own keys, since settings have no ids: it
puts each key it touches back as it found it, but run it against settings
nothing else is using. A key holding a value the store must refuse (a
selection that is not `"<provider>:<modelId>"`, a count below 1, left by an
older unchecked write) could not be put back, so the check that would touch it
fails before writing anything. `@xandreed/plugin-models` runs these three kits against
its file and in-memory stores, on Bun and on Node.

The image checks of
`memoryConformance` and `turnConformance` need a memory whose budget admits
one small image, as the memory plugins' defaults do: one set to send no
images (`maxImages: 0` or `maxMediaChars: 0`) fails them.

## Running a kit

Map the checks to tests in whatever runner you use. With Bun's test runner
(Vitest and `node:test` look the same):

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sessionLogConformance } from "@xandreed/core/conformance"
import { log } from "./my-session-log.js" // your SessionLog implementation

describe("my session log conforms to the SessionLog contract", () => {
  sessionLogConformance(log).map((check) => test(check.name, async () => {
    const result = await Effect.runPromise(Effect.result(check.run))
    expect(result._tag === "Failure" ? result.failure.message : "ok").toBe("ok")
  }))
})
```

To fail a deploy check or a script instead, run them all and collect the
failures:

```ts
const failures = await Effect.runPromise(Effect.forEach(sessionLogConformance(log), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [`${check.name}: ${result.failure.message}`] : []))))
if (failures.flat().length > 0) throw new Error(failures.flat().join("\n"))
```

## The SessionLog recovery kit

`sessionLogConformance` checks one handle on a store. A real store is opened
by several processes, restarted, and sometimes left behind by a process that
was killed. `sessionLogRecoveryConformance` checks, inside one process, what
must hold across handles, reopening and interruption, and takes a subject
rather than a log:

```ts
interface SessionLogSubject {
  /** A new handle on the same stored data each time it runs, released with its scope. */
  readonly open: Effect.Effect<SessionLog["Service"], SessionLogError, Scope.Scope>
  /** The backend stamps time with the caller's Effect Clock: also check the notAfter boundary. */
  readonly callerClock?: boolean
}
```

`open` should do what your host does on start: open a connection to the
database or file and close it when the scope closes. The checks:

- **reopen**: what a handle committed (events, state, times, the listing) is
  all there after it closes and the store is opened again.
- **reopen-twice**: opening an existing store again is idempotent; nothing
  is lost and commits continue from the stored revision.
- **cross-handle**: two open handles see each other's commits at once, and a
  stale revision through either is refused.
- **cross-handle-race**: compare-and-swap commits racing through two handles
  have exactly one winner per revision; no increment is lost or stored twice.
- **interrupted-commit**: a commit interrupted at any point leaves all of
  its events or none, and the session takes the next commit. The commit must
  have settled by the time the interrupt returns: a backend whose write can
  land after its caller stops waiting (a request already sent to a server)
  makes that write uninterruptible, or the check fails now and then.
- **unclosed-handle**: a handle whose scope never closed (leaked, or held by
  a process that hangs) blocks nothing; a new handle reads all it committed
  and commits after it.
- **expiry-boundary**, only with `callerClock: true`: with the clock stopped,
  a commit at exactly its `notAfter` is stored at that time, and one a
  millisecond later is refused with `LeaseExpired`.

Each check must finish within 30 seconds, so a handle that waits on another
fails the check rather than hanging it.

The SQLite log is the reference subject. `makeSessionLogSqlite(path)` is the
scoped log `SessionLogSqliteLive` builds:

```ts
import { sessionLogRecoveryConformance } from "@xandreed/core/conformance"
import { makeSessionLogSqlite } from "@xandreed/plugin-session-sqlite"

const checks = sessionLogRecoveryConformance({ open: makeSessionLogSqlite("/tmp/recovery.db"), callerClock: true })
```

An in-memory log passes only when every `open` returns the same store, the
way two connections reach the same database. Build it once and return it;
a fresh `SessionLogMemoryLive` per open starts empty and fails every check
that opens the store again:

```ts
const log = await Effect.runPromise(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))
const checks = sessionLogRecoveryConformance({ open: Effect.succeed(log), callerClock: true })
```

The kit's own tests run it against careless backends, which is the point: one
that buffers writes until a handle closes passes reopening and fails
`cross-handle`, `cross-handle-race` and `unclosed-handle`; one that writes a
commit's events one at a time, with no transaction around them, passes
everything but `interrupted-commit`.

A process that crashes is not a handle left open: the operating system
releases its files and locks. The SQLite package tests crashes and other
processes with real ones: several processes opening one new file at once, a
commit that waited behind another process's write lock past its `notAfter`
is refused, a process killed in the middle of committing leaves whole
commits, two processes making 200 compare-and-swap increments each end at
400 after conflicting, and a turn held by a killed process is reaped under
process and lease ownership.

See [SDK and sessions](/docs/concepts/harness) for how sessions use the log.

## The Sessions kit

`sessionsConformance` checks a `Sessions` backend the way hosts and turns
use it: over one store, opened by several instances at once (one per
server), with leases that run out and processes that stop. It takes a
subject that opens instances and moves the clock:

```ts
interface SessionsSubject {
  /** Another instance over the same store each time, its turns leased for ttlMs, renewed only by their writes. */
  readonly leased: (options: { ttlMs: number; admission: TurnAdmission["Service"] }) => Effect.Effect<SessionsInstance, unknown, Scope.Scope>
  /** The same, its turns held by the process `self`; of its host's pids only `running` run. Optional. */
  readonly processOwned?: (options: { self: SessionsProcess; running: ReadonlyArray<number>; admission: TurnAdmission["Service"] }) => Effect.Effect<SessionsInstance, unknown, Scope.Scope>
  /** Move the clock the store and the instances read: TestClock.adjust, or a sleep. */
  readonly advance: (millis: number) => Effect.Effect<void>
}
interface SessionsInstance {
  readonly sessions: Sessions["Service"]
  /** Its TurnActivity, when it has one; without one, the activity check passes unchecked. */
  readonly activity: Option.Option<TurnActivity["Service"]>
}
interface SessionsProcess { readonly host: string; readonly pid: number; readonly startedAt: number }
```

The kit passes its own `TurnAdmission` to every instance (it admits all,
records what it is shown, holds a begin, or refuses one), so an instance
must use the admission it is given. `@xandreed/plugin-sessions` runs the kit
over `SessionsLive` and the in-memory log, each check under a `TestClock` of
its own; `@xandreed/plugin-session-sqlite` runs it over the SQLite log the
same way, and `verify:packages` on Node:

```ts
import { Context, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { SessionLog, Sessions, TurnActivity, TurnAdmission } from "@xandreed/core"
import { sessionsConformance } from "@xandreed/core/conformance"
import type { SessionsSubject } from "@xandreed/core/conformance"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import type { ProcessLiveness, SessionsConfig } from "@xandreed/plugin-sessions"

declare const log: SessionLog["Service"] // one store for every instance and check

const instance = (config: SessionsConfig, admission: TurnAdmission["Service"], liveness?: ProcessLiveness) =>
  Layer.build(SessionsLive(config, liveness === undefined ? undefined : { liveness }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), Layer.succeed(TurnAdmission, admission))))).pipe(
    Effect.map((context) => ({ sessions: Context.get(context, Sessions), activity: Context.getOption(context, TurnActivity) })))

const subject: SessionsSubject = {
  leased: ({ ttlMs, admission }) => instance({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs, renew: "on-commit" } }, admission),
  processOwned: ({ self, running, admission }) => instance({ ...sessionsDefaults, ownership: { mode: "process" } }, admission,
    { current: Effect.succeed(Option.some(self)), alive: (pid) => Effect.succeed(running.includes(pid)) }),
  advance: (millis) => TestClock.adjust(millis),
}
// Run each check under the clock `advance` moves.
const checks = sessionsConformance(subject).map((check) => ({ ...check, run: check.run.pipe(Effect.provide(TestClock.layer())) }))
```

The checks:

- **create**: a new session is empty and read back by its owner; another
  owner's address and an unknown id are `SessionMissing`; an id is created
  once (`SessionExists`).
- **list**: an owner's sessions newest first, in pages that continue from
  `next`; a session's children only under `parent`.
- **fork**: a fork's lineage and history are its parent's up to the last
  closed turn (a turn still open is left out) and its turns count on from
  there; a spawn starts empty; forking a missing session is `SessionMissing`.
- **busy**: the admitted turn is what was asked for; every instance shows it
  open and answers a second begin with `SessionBusy`; the next turn opens
  after the end.
- **race**: of begins racing on one session from three instances, exactly one
  opens a turn.
- **duplicate**: a key's retry is `TurnDuplicate` (open, then not) whatever
  its `meta`; another message or command under the key is `KeyConflict`;
  `lookup` finds the key's turn.
- **run-id**: a begin under a run id an earlier turn used, under a new key
  or as an inbox turn, is `RunIdReused` (the same key is still
  `TurnDuplicate`) and stores nothing; in a fork, its parent's run ids are
  refused too and a new one opens the fork's next turn.
- **meta**: `meta` is stored in `turn.started`, admitted and shown to the
  host's admission; `{}` when none is given; the inbox's from `drain`.
- **resume**: a cancelled turn is resumed (`resumes` admitted and stored), a
  retried resume is `TurnDuplicate`, and every other case is `NotResumable`
  with its reason (`finished`, `missing`, `superseded`, `inbox`), or
  `SessionBusy` while a turn is open.
- **task**: a task's turn (`BeginTurn.Task`) is admitted with origin `task`
  and its `TaskRef`, stored so in `turn.started`, shown open as a task's and
  shown to the host's admission; its key's retry is `TurnDuplicate` and
  another task under the key `KeyConflict`; resuming it, once cancelled, is
  `NotResumable` (`task`).
- **attachments**: an image its bytes do not support is
  `AttachmentRejected` and opens nothing; a good one is admitted and stored.
- **nothing-pending**: an inbox turn with nothing waiting is `NothingPending`
  and a drain runs none.
- **writer**: writes are stored in order, stamped with the turn; the end
  stores `completed`, a failure's code, `turn.unended` for a scope closed
  without an end and `turn.interrupted` for an interrupted one; a write after
  the end is refused with `TurnClosed` (`ended`).
- **transact**: records outside a turn; `turn.*` kinds are `ReservedKind`.
  A turn's writer refuses a `turn.ended` or a `memory.message` with
  `ReservedKind`, storing nothing of that call and leaving the turn open,
  and stores a reserved kind the framework's turn wrote (`frameworkDraft`).
- **cancel**: ends exactly the open turn as cancelled; the holder's writer
  is closed at once on its own instance, and at its next write when the
  cancel came from another; a write after it is refused with `TurnClosed`
  (`cancelled`).
- **cancel-unheld**: an inbox turn whose lease ran out is reaped by a
  cancel as by a delivery: whichever comes first, nothing is cancelled, the
  turn ends `interrupted` (`turn.lease`) and its item waits alike.
- **remove**: removing a session closes its open turn (`removed`) and
  removes its children.
- **inbox**: an item is stored once per id (even after it was taken), taken
  by one inbox turn whose message frames it, waits for an open turn (whose
  end reports it), comes back when its turn is interrupted from outside, and
  is done when its turn is cancelled (a later drain takes nothing).
- **lease**: a turn within its lease is open and busy; past it, it is shown
  closed, a drain with nothing waiting stores nothing (only a turn that
  opens reaps), the next begin reaps it (`interrupted`, `turn.lease`) and the
  old holder's writes are refused with `TurnClosed` (`interrupted`).
- **lease-renewal**: a write renews the lease from that write: a turn
  written to within its lease is still open and busy past its first lease,
  and reaped once a lease has passed since the write.
- **process**, only with `processOwned`: a turn whose process stopped, or
  whose pid now belongs to a process that started later, is reaped by the
  next begin, its writes refused with `TurnClosed` (`interrupted`); one
  whose process runs is held.
- **tenure**, only with `processOwned`: a turn is judged as it was taken,
  not by the reader's ownership: a process-owned instance shows a leased
  turn open and busy within its lease, its holder still writes, and once the
  lease ran out the process-owned instance reaps it (`turn.lease`).
- **activity**, for an instance with a `TurnActivity` (one without passes
  it unchecked): it counts a begin from the moment it is asked
  for (while the host's admission holds it), then its turn per session and
  turn, oldest first, until its writer's scope closes, an ended turn
  included; another instance's turns and a refused begin do not count;
  `idle` completes only when nothing is open or beginning.

The kit's own tests run it against careless wrappers of `SessionsLive`: a
`begin` that cancels the open turn instead of refusing it fails `busy`,
`duplicate`, `lease`, `lease-renewal`, `process`, `race`, `resume` and
`tenure`; a
`TurnActivity` that always reads idle fails `activity`; a `begin` that drops
`meta` fails `meta`; leases that writes do not renew (`renew: "none"`) fail
`lease-renewal`; writers that take the framework's kinds from anyone fail
`transact`; a `begin` that opens a reused run id's turn under a new one
fails `run-id`; a `begin` that opens a task's turn as a user's fails
`task`.

## The task kits

`taskRunnerConformance(make, options?)` checks a `TaskRunner`, the place
background work runs. `make` builds one for each check, with its
`TaskActivity` when it has one:

```ts
interface TaskRunnerFixture {
  readonly runner: TaskRunner["Service"]
  readonly activity: Option.Option<TaskActivity["Service"]>
}
```

- **hand-over**: `run` returns once the work is handed over, before it ends,
  and the work runs once.
- **outlives-caller**: the work goes on when the caller that handed it over
  is interrupted and its scope closed.
- **deadline**: the work is told a deadline that is none or not in the past.
- **isolation**: the work runs without the caller's services (the turn that
  starts a task ends before it).
- **activity**: with a `TaskActivity`, the work counts from the moment `run`
  returns until it ends, and `idle` waits for all of it.
- **scope-close**: closing the scope the runner was made in interrupts the
  work still running, so a task's turn ends interrupted rather than lost. A
  runner that hands work to the platform (a serverless `waitUntil`) cannot,
  and passes `{ interruptsOnClose: false }` to leave it out.

The checks wait up to two seconds on the live clock for work they expect,
so run the kit without a `TestClock`. `InProcessTaskRunnerLive` passes them
all, with and without a deadline (`maxMs`); core's tests show a runner that
runs the work in the caller failing `hand-over`, `outlives-caller`,
`isolation` and `scope-close`, and one that forks it loose failing
`isolation` and `scope-close`.

```ts
import { Context, Effect, Layer } from "effect"
import { TaskActivity, TaskRunner } from "@xandreed/core"
import { taskRunnerConformance } from "@xandreed/core/conformance"
import { InProcessTaskRunnerLive } from "@xandreed/plugin-tasks"

const checks = taskRunnerConformance(Layer.build(InProcessTaskRunnerLive()).pipe(Effect.map((context) => ({
  runner: Context.get(context, TaskRunner),
  activity: Context.getOption(context, TaskActivity),
}))))
```

`tasksConformance(make)` checks a `Tasks` backend. `make` builds it, and the
`Sessions` it runs over, with the kit's own runner (each piece of work on a
fiber the kit waits for, with the services there were when the check built
the runner and none of its caller's, or dropped, as by a runner that died)
and executor (a child turn answers `found: <instructions>` unless the check
says otherwise; a reaction records the turn it ran on; both look up the
task in the `Tasks` they run with, which must be the backend's). Like the runner
kit, it waits up to two seconds on the live clock for background work, so
run it without a `TestClock`:

```ts
import { Context, Effect, Layer } from "effect"
import { SessionLog, Sessions, TaskExecutor, TaskRunner, Tasks, TurnAdmissionOpen } from "@xandreed/core"
import { tasksConformance } from "@xandreed/core/conformance"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { TasksLive, tasksDefaults } from "@xandreed/plugin-tasks"

declare const log: SessionLog["Service"]

const checks = tasksConformance(({ runner, executor }) => Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(
  SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen))),
  Layer.succeed(TaskRunner, runner),
  Layer.succeed(TaskExecutor, executor),
)))).pipe(Effect.map((context) => ({ sessions: Context.get(context, Sessions), tasks: Context.get(context, Tasks) }))))
```

- **run**: a task runs as one turn of a child session of the parent (a
  spawn's history is empty), a task's turn (origin `task`, its `TaskRef`
  the task's and the parent's ids); its result reaches the parent's inbox once, and
  the parent reacts once, to an inbox turn whose item carries the reply; the
  parent records one `task.started`, and lists the task.
- **start-once**: three starts of one task id, while it runs and after, run
  it once; the id with other instructions or another mode is
  `TaskConflict`.
- **task-id**: a task id naming the parent or another of the owner's
  sessions is `SessionExists`; nothing is recorded, run or written there.
- **after-turn**: a result that arrives while the parent's turn is open
  waits for that turn, whose end reports it; a fork's history is the
  parent's up to its last closed turn.
- **failed**: a failed child turn is a `failed` task whose failure carries
  the error's code, and the parent still hears of it.
- **cancel**: cancelling a running task ends its child's turn cancelled and
  delivers nothing; a cancelled task is not cancelled again, and an unknown
  one is `TaskMissing`.
- **depth**: a task's session cannot start tasks (`TaskRefused`, `depth`);
  a host's own fork of the conversation can.
- **reconcile**: a task whose runner dropped it stays `pending` until
  `reconcile` starts it, and then delivers; a second `reconcile` finds
  nothing.
- **reconcile-delivery**: a task that finished while the parent's inbox was
  full (`InboxFull`) reads `completed` and not delivered; once the inbox is
  drained, `reconcile` delivers it (once), the parent reacts to it after
  the caller drains, and a second `reconcile` finds nothing. The kit fills
  the inbox itself, so this check relies on the backend keeping a result the
  full inbox refused for a later `reconcile`, and runs only over a
  `Sessions` whose inbox refuses an item within 256 deliveries; over one
  that takes them all it passes unchecked.

`TasksLive` passes them; a `cancel` that stops nothing fails `cancel`, a
`start` that ignores the task id fails `start-once` and `task-id`, a `list` that returns
nothing fails `run` and `start-once`, a `reconcile` that does nothing fails
`reconcile` and `reconcile-delivery`, and one that leaves a result whose
delivery was lost undelivered fails `reconcile-delivery`; a `start` that
judges depth by a session's lineage (refusing a host's fork) fails `depth`,
and sessions that begin the child's turn as a user's fail `run`.

## The ToolRegistry kit

`toolRegistryConformance(make)` checks a `ToolRegistry`. `make` builds one
over the kit's capabilities (five tools and three skills: an always-on one,
one needing the `kit.vault` permission, one loaded on demand; one tool
declares the `SessionEnvironment` it reads) with at most `maxCallsPerRun`
calls per turn and no permission granted by default. Each check runs a turn
over core's `TurnLive`, with a writer that keeps the turn's events in
memory, opens the tools with a `SessionEnvironment` and calls them through
the open toolkit's handlers with another:

```ts
import { Context, Effect, Layer } from "effect"
import { Capabilities, ToolRegistry } from "@xandreed/core"
import { toolRegistryConformance } from "@xandreed/core/conformance"
import { toolDiscoveryDefaults, ToolDiscoveryLive } from "@xandreed/plugin-tool-discovery"

const checks = toolRegistryConformance((capabilities, limits) =>
  Layer.build(ToolDiscoveryLive({ ...toolDiscoveryDefaults, ...limits }).pipe(Layer.provide(Layer.succeed(Capabilities, capabilities)))).pipe(
    Effect.map((context) => Context.get(context, ToolRegistry))))
```

- **catalog**: the catalog and the run's tools hold every skill and tool,
  with the permissions a tool needs.
- **activation**: always-on skills are active once the matcher's choice is
  applied, others only once activated (publishing `skills.activated` once);
  an unknown skill fails with `skills.unknown`; a skill whose permission is
  not granted stays inactive; the active set only grows.
- **concurrent-load**: `load_skill` calls running at once (a step's calls
  with a tool concurrency above 1, the kit's writer yielding at every write
  as storage does) leave every skill's tools active, listed and callable,
  each published in `skills.activated` and recorded in memory once, also
  when two calls load the same skill. The kit's registry must serve
  `load_skill`.
- **invocation**: a handled call publishes `tool.started`, its handler's
  `tool.progress` and `tool.completed` under one invocation id, taken after
  the refused call before it (`<runId>:call:<n>`); the handler sees that call
  as `CurrentToolInvocation` and the services where the tools were opened,
  not the caller's; the events are published on the run's bus only, so
  `tool.progress` never reaches the journal.
- **requires-missing**: a run lacking a service a tool declares (here the
  `SessionEnvironment`) fails to open its tools with `requires.missing`,
  naming the tool and the service.
- **requires-opened**: a handler sees the services it declares as they are
  where the tools were opened, not where it is called.
- **grants**: the turn's `PermissionGrants` let a skill that needs them be
  activated and its tools run.
- **refused-inactive**, **refused-forbidden**, **refused-denied**,
  **refused-call-limit**, **refused-tool-call-limit**: a call refused before
  its handler runs (a tool not loaded, a permission the turn lacks, an
  `ActionPolicy` denial, the turn's call limit, the tool's own) takes its
  invocation id first, publishes one `tool.refused` with its input and no
  `tool.started` on the run's bus only, never runs the handler, and returns
  the refusal's message as its failed result.

A registry publishes on the run's bus (`RunContext.events`) and never
writes the journal itself: the turn journals what it publishes, and core's
`TurnLive` is what keeps `tool.progress` out of the journal and stores a
`tool.refused` without its input. The kit reads the journal to catch a
registry that writes it directly, so those checks guard the registry, not
the turn's own journaling.

The plugin's registry passes them; its tests show a registry that ignores
the turn's call limit failing `refused-call-limit`, one that activates every
skill when the tools open failing `activation`, `invocation` and
`refused-inactive`, one whose catalog drops the permissions failing
`catalog`, one that opens the tools without checking what they declare
failing `requires-missing`, and one that opens them over services of its
own failing `requires-missing` and `requires-opened`.

## The FileSystem kit

`fileSystemConformance` opens a fixture for each check: the port, an empty
absolute directory `root` to work in, and a way to make symbolic links (the
port has no call for that):

```ts
interface FileSystemSubject {
  /** A fresh empty root each time, released (and removed) with its scope. */
  readonly open: Effect.Effect<FileSystemFixture, unknown, Scope.Scope>
}
interface FileSystemFixture {
  readonly fs: FileSystem["Service"]
  readonly root: string
  readonly symlink: (target: string, path: string) => Effect.Effect<void, unknown>
}
```

Core runs the kit over its in-memory backend, giving it its own
tree for each check:

```ts
import { Effect } from "effect"
import { makeMemoryFileSystem } from "@xandreed/core"
import { fileSystemConformance } from "@xandreed/core/conformance"

const checks = fileSystemConformance({
  open: makeMemoryFileSystem().pipe(
    Effect.tap((fs) => fs.mkdir("/work")),
    Effect.map((fs) => ({ fs, root: "/work", symlink: fs.symlink })),
  ),
})
```

For a backend on disk, `open` makes a temporary directory and removes it
when the scope closes, with `fs.symlink` as `symlink`. That is how
`@xandreed/plugin-workspace` runs it over `FileSystemLive`, the local disk
through `node:fs/promises`, on Bun and on Node:

```ts
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { fileSystemConformance } from "@xandreed/core/conformance"
import { localFileSystem } from "@xandreed/plugin-workspace"

const temporary = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "fs-kit-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
)
const checks = fileSystemConformance({
  open: temporary.pipe(Effect.map((root) => ({
    fs: localFileSystem,
    root,
    symlink: (target: string, path: string) => Effect.tryPromise(() => symlink(target, path)),
  }))),
})
```

The checks:

- **read-write**: text (UTF-8 included) and bytes read back exactly, a
  write replaces the whole file, and reading a missing file, reading or
  writing a directory and writing below a file fail with `NotFound`,
  `IsDirectory` and `NotDirectory`.
- **create-parents**: without `createParents` a missing directory fails with
  `NotFound`; with it, `write` and `append` create every directory on the way.
- **read-bytes**: `readBytes` returns the range asked for, what there is of a
  range past the end, and refuses a negative offset with `Invalid`.
- **append**: creates a missing file and adds text and bytes in order.
- **rename**: moves a file, replaces an existing file at the target, moves a
  directory with what it holds, moves a link itself (not its target), and
  names the side a failure came from: the source when it is missing, the
  target for a missing parent there or what is in the way (`IsDirectory`,
  `NotDirectory`, `NotEmpty`).
- **stat**: kind, size in bytes and time; a link is followed unless
  `followSymlinks: false`, which reports `symlink`.
- **exists**: true for files and directories; false, never an error, for a
  missing path and a link whose target is missing.
- **list**: entries sorted by name (code-unit order, so `C.txt` before
  `a.txt`) with their kinds, links not followed.
- **glob**, **glob-recursive**, **glob-dot**, **glob-only-files**,
  **glob-limit**, **glob-errors**: `*`, `?`, classes and braces within a
  segment; `**` across directories but never into a linked one; `exclude` by
  name or by path; dot entries only with `dot` or a literal dot in the
  pattern; `onlyFiles` keeping regular files only; `limit` keeping the first
  paths in walk order and `truncated` only when more matched; a missing
  `cwd`, an absolute pattern and a `..` segment refused.
- **mkdir**: one directory, or with `recursive` every missing one,
  idempotently; otherwise an existing path fails with `Exists` and a missing
  parent with `NotFound`.
- **real-path**: absolute and relative links on the way are resolved.
- **remove**: a missing path is a no-op, an empty directory goes without
  `recursive`, one with entries fails with `NotEmpty` until `recursive`, and
  removing a link leaves its target.
- **remove-paths**: `remove` acts on the last name as written. A link named
  with a trailing slash (`link/`) is removed and its target kept, with or
  without `recursive`; a link in the parent (`via/sub`) is followed; a path
  whose last segment is `.` or `..` fails with `Invalid`. A disk backend
  that hands the path to `rmdir` or `rm` as given fails here: the kernel
  follows the trailing slash and resolves the `..`, so `<link>/..` could
  reach the root. Every path the check removes is under the fixture's root,
  even on such a backend.

Every backend should implement `glob` as `walkGlob(list, pattern, options)`
over its own `list`. That is what makes the glob checks pass on Bun and on
Node: `fs.glob` cannot list dot entries on Node and follows links on Bun. The
kit's own tests show what it catches. A backend that lists in reverse order,
refuses to remove a missing path and always follows links in `stat` fails
`list`, `remove`, `remove-paths`, `stat` and `rename` (`rename` and
`remove-paths` read a link without following it); a `rename` that moves a link's target instead of
the link, or that names the source for every failure, fails `rename`; a
`remove` that resolves the whole path first fails `remove` and
`remove-paths`; a glob that follows links fails `glob`, `glob-recursive`,
`glob-dot` and `glob-limit`; one that lists dot entries whatever `dot` says
fails every glob check with a dot entry in reach.

## The Bash kit

`bashConformance` opens a `Bash` adapter and an empty directory for each
check. The adapter's parent environment must be the process's own plus
`planted`, so the kit can check what a command inherits:

```ts
interface BashSubject {
  readonly open: (planted: Readonly<Record<string, string>>) => Effect.Effect<BashFixture, unknown, Scope.Scope>
  readonly holdsBack?: boolean // whether a slow reader holds the command back; true when left out
}
interface BashFixture {
  readonly bash: Bash["Service"]
  readonly root: string
}
```

The checks:

- **exit-code**: a non-zero exit is a result with its code, not an error.
- **streams**: stdout and stderr stay apart, chunks carry their stream, and
  exactly one `BashExit` comes last.
- **streaming**: output arrives while the command still runs. The command
  waits for the kit to see its first output before it exits, so an adapter
  that holds output until exit fails here.
- **stdin**: `stdin`, text or bytes, is delivered and then closed; without
  it the command reads end-of-file at once.
- **stdin-ignored**: a command that exits without reading a megabyte of
  stdin still yields its exit (the adapter must not die of the broken pipe).
- **env**: `env` is set over the parent environment.
- **inherit-env**: by default only the allowlist passes (`PATH` and `LC_*`
  do, a planted secret does not); `inheritEnv: true`, `false` and an
  allowlist with a `*` prefix do what they say.
- **timeout**: a command past `timeoutMs` ends with `termination: "timeout"`,
  and a child it left in the background is gone too.
- **cwd**: the command runs in `cwd`; a missing one, or a file, fails with
  `CwdMissing`.
- **signal**: a command killed by a signal reports `termination: "signal"`
  and the signal's name.
- **utf8**: a character written in two pieces arrives whole.
- **backpressure**: a reader that stops after the first chunk holds the
  command back: 64 MB of output is not all written a second later (the
  adapter must not gather output without bound), and once reading resumes
  every character arrives, in order, with one `BashExit`. Bun (1.3) reads a
  child's pipes ahead of any reader, into its own memory, so a subject over
  those pipes on Bun sets `holdsBack: false` and only the second half is
  checked; `BashLive` passes the whole check on Node.
- **interrupt**: interrupting the stream returns, and kills the command and
  the child it started.

Core has no `Bash` adapter: the kit's own tests run it against fakes that
run nothing, which fail every check. `BashLive` from
`@xandreed/plugin-workspace` (commands through `node:child_process`) passes
it on Bun and on Node. Its `parentEnv` option is the environment commands
inherit from, which is how a test plants variables:

```ts
import { Effect } from "effect"
import type { Scope } from "effect"
import { bashConformance } from "@xandreed/core/conformance"
import { makeBash } from "@xandreed/plugin-workspace"

declare const temporary: Effect.Effect<string, never, Scope.Scope> // as in the FileSystem kit above

const checks = bashConformance({
  open: (planted) => Effect.all({ root: temporary, bash: makeBash({ parentEnv: { ...process.env, ...planted } }) }),
})
```

## The AuthStore and SettingsStore kits

`authStoreConformance(store)` and `settingsStoreConformance(store, { writable })`
call the store and nothing else. Two options reach further, and each turns on
its checks:

```ts
interface AuthStoreConformanceOptions {
  /** The token endpoint the store refreshes through, which the test controls. */
  readonly refresh?: AuthStoreRefreshProbe
  /** Damage the store's backing data for the scope's lifetime, repairing it when the scope closes. */
  readonly corrupt?: Effect.Effect<void, never, Scope.Scope>
}
interface AuthStoreRefreshProbe {
  /** A provider whose expired OAuth token the store refreshes through the endpoint. */
  readonly provider: ProviderId
  /** The token requests the endpoint has received. */
  readonly requests: Effect.Effect<number>
  /** Hold requests unanswered until the returned effect runs. */
  readonly hold: Effect.Effect<Effect.Effect<void>>
}
```

- **refresh-once**: four concurrent `resolveKey` calls on one expired token
  send one token request, all get its new token, and the store keeps it.
- **refresh-remove**: a `remove` made while the token request is held sticks:
  the refreshed token is not stored.
- **corrupt**: while the backing data is damaged, `get`, `all`,
  `resolveKey`, `set` and `remove` fail with an `AuthError` of code
  `auth.corrupt`, and the store reads its data again once it is repaired.

The refresh checks write the probe's provider and put back what it held. They
wait for the store's token requests on the live clock (up to two seconds), so
run them without a `TestClock`. `SettingsStoreConformanceOptions` takes the
same `corrupt` beside `writable`: `load`, and for a writable store `setRole`
and `set`, fail with a `SettingsError` of code `settings.corrupt`. Damage what
the store writes to, so that a write over the damage shows. A store in memory
has nothing to damage and leaves `corrupt` out.

`@xandreed/plugin-models` runs both kits with these options over its file
stores (the probe is a `fetch` the store is built over, the damage is text that
is not JSON written over `auth.json` or `config.json`) and the refresh checks
over its memory store, on Bun and on Node:

```ts
import { Effect, Layer } from "effect"
import type { Scope } from "effect"
import { authStoreConformance, AuthStore } from "@xandreed/core/models"
import type { AuthStoreRefreshProbe } from "@xandreed/core/models"
import { LocalAuthStoreLive, ModelsTransport } from "@xandreed/plugin-models"
import type { ModelsFetch } from "@xandreed/plugin-models"

declare const cwd: string, home: string
declare const endpoint: { readonly fetch: ModelsFetch; readonly probe: AuthStoreRefreshProbe } // a fetch that answers token requests
declare const damaged: (path: string) => Effect.Effect<void, never, Scope.Scope> // writes "{ not json", restores on close

const store = await Effect.runPromise(Effect.service(AuthStore).pipe(Effect.provide(
  LocalAuthStoreLive(cwd, home, ".efferent/runtime").pipe(Layer.provide(Layer.succeed(ModelsTransport, ModelsTransport.of({ fetch: endpoint.fetch })))))))
const checks = authStoreConformance(store, { refresh: endpoint.probe, corrupt: damaged(`${home}/.efferent/runtime/auth.json`) })
```

## Render kits

`@xandreed/plugin-render` exports three kits for its ports. Their checks have
the same shape, `name` and `run`, and fail with core's
`ConformanceFailure` (`check`, `message`; the package re-exports it) or a
`RenderError`:

| Kit | Checks | Run against |
| --- | --- | --- |
| `renderSurfaceConformance(subject)` | generations opened only by changed content, operation ids per surface and generation, completion once per version, a retried publish committing what a failed one left out (also after reopening), freezing (before the first publish too, and per surface) and placeholder fills in each version, threads that never see each other's records, preparations one at a time, reopening, rejected components never committed, an idempotent store, two writers of one message never planning the same version, a store that refuses a plan skipping or repeating a generation and every write under a lower fence (`forbidden`) | a `SurfaceSubject`, whose `make(admission)` builds a fresh `Render` and `RenderStore` for each check |
| `renderFeedConformance(makeFeed)` | resuming after the cursor with one ready frame, heartbeats while idle, records in order, polling at once on a change signal | a function that builds a `RenderFeed` over a `JournalTail` (`makeMemoryJournal` gives one to append to) |
| `renderTransportConformance({ sse, socket })` | SSE and WebSocket carry identical frames | the two `RenderTransport`s |
