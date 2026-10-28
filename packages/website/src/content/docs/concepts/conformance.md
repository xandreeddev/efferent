---
title: Conformance kits
description: The port contracts as runnable checks, to run against your own adapter in any test runner.
---

# Conformance kits

A port says what its methods take and return; a conformance kit says what an
implementation must do. `@xandreed/core` ships each contract as a list of
checks, so a host that writes its own session store, memory strategy, step
loop or turn composition can prove it behaves like the first-party ones.
`@xandreed/plugin-render` does the same for render surfaces, feeds and
transports (see [render kits](#render-kits)).

## The kits

| Kit | Checks | Run against |
| --- | --- | --- |
| `sessionLogConformance(log)` | dense sequence numbers, one revision per commit, compare-and-swap, the `notAfter` clock check, JSON kept by value, reads by position and kind, listing order, children and their removal | a `SessionLog` |
| `sessionLogRecoveryConformance(subject)` | reopening, several open handles, interrupted commits, a handle whose scope never closed, the exact `notAfter` boundary | a way to open a `SessionLog` |
| `memoryConformance(memory, services)` | own entry ids, a log that reads back exactly after a reopen, views and artifacts kept, a pure build, append-only maintenance | a memory strategy |
| `stepLoopConformance(loop)` | per-step event order, validation before dispatch, planned batches, forced tool choices, no call after completion, the step cap | a `StepLoop` |
| `turnConformance(runner, services)` | the writer first, the message before the matcher's history, the reply and the end exactly once, tasks joined before the reply | a turn composition |

Every core kit returns `ReadonlyArray<ConformanceCheck>`. A check has a `name` and
a `run` effect that succeeds, or fails with a `ConformanceFailure` whose
`check` names the broken part of the contract and whose `message` says what
happened. The session log kits use fresh session ids and owners in every
check, so they can run against a shared database.

## Running a kit

Map the checks to tests in whatever runner you use. With Bun's test runner
(Vitest and `node:test` look the same):

```ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sessionLogConformance } from "@xandreed/core"
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
import { sessionLogRecoveryConformance } from "@xandreed/core"
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

## Render kits

`@xandreed/plugin-render` exports three kits for its ports. Their checks have
the same shape, `name` and `run`, and fail with that package's own
`ConformanceFailure` (`check`, `message`) or a `RenderError`:

| Kit | Checks | Run against |
| --- | --- | --- |
| `renderSurfaceConformance(subject)` | generations opened only by changed content, completion once per version, freezing and placeholder fills, preparations one at a time, reopening, rejected components never committed, an idempotent store | a `SurfaceSubject`, whose `make(admission)` builds a fresh `Render` and `RenderStore` for each check |
| `renderFeedConformance(makeFeed)` | resuming after the cursor with one ready frame, heartbeats while idle, records in order, polling at once on a change signal | a function that builds a `RenderFeed` over a `JournalTail` (`makeMemoryJournal` gives one to append to) |
| `renderTransportConformance({ sse, socket })` | SSE and WebSocket carry identical frames | the two `RenderTransport`s |
