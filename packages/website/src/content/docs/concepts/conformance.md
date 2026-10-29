---
title: Conformance kits
description: The port contracts as runnable checks, to run against your own adapter in any test runner.
---

# Conformance kits

A port says what its methods take and return; a conformance kit says what an
implementation must do. `@xandreed/core` ships each contract as a list of
checks, so a host that writes its own session store, memory strategy, step
loop, turn composition, file system, shell or model credential and settings
store can prove it behaves like the first-party ones
(`@xandreed/plugin-workspace`'s local file system and shell pass the
file-system and shell kits on Bun and Node).
`@xandreed/plugin-render` does the same for render surfaces, feeds and
transports (see [render kits](#render-kits)).

## The kits

| Kit | Checks | Run against |
| --- | --- | --- |
| `sessionLogConformance(log)` | dense sequence numbers, one revision per commit, compare-and-swap, the `notAfter` clock check, JSON kept by value, an event as large as a message's images at their limit (`MEDIA_LIMITS.requestChars` base64 characters), reads by position and kind, listing order, children and their removal | a `SessionLog` |
| `sessionLogRecoveryConformance(subject)` | reopening, several open handles, interrupted commits, a handle whose scope never closed, the exact `notAfter` boundary | a way to open a `SessionLog` |
| `memoryConformance(memory, services)` | own entry ids, a log that reads back exactly after a reopen, views and artifacts kept, a pure build, append-only maintenance, a message's images through a reopen (the current turn's built as image parts, an earlier turn's as image parts or label lines) | a memory strategy |
| `stepLoopConformance(loop)` | per-step event order, validation before dispatch, planned batches, forced tool choices, no call after completion, the run's usage (the sum of its `assistant.message` usage), the step cap, the request's `captureTraceContent` reaching its model calls as `CurrentTraceContent` | a `StepLoop` |
| `turnConformance(runner, services)` | the writer first, the message before the matcher's history, the reply and the end exactly once, tasks joined before the reply, a model-driven turn's usage equal to its stored `step.usage` records (`turnUsageOf`), the user's attachments stored with the turn and reaching the first request as image parts, the host layer seeing only earlier turns | a turn composition |
| `fileSystemConformance(subject)` | round trips, `createParents`, byte ranges, append, rename, `stat` and links, sorted listings, `glob`, `mkdir`, `realPath`, the `remove` rules, the `reason` of every failure | a way to open a `FileSystem` over an empty directory |
| `bashConformance(subject)` | exit codes as results, separate streams, output before exit, stdin, the inherited-environment allowlist, timeouts and interrupts that kill the process group, `cwd`, signals, UTF-8 | a way to open a `Bash` adapter |
| `authStoreConformance(store)` | an absent provider, API key, `local` and OAuth credentials read back and resolve as they should (the key `Redacted`), an expired token the store cannot refresh fails with an `AuthError` naming the provider and never returns the stale token, `set` replaces, `remove` deletes everywhere and is a no-op for an absent provider, providers are isolated | an `AuthStore` |
| `settingsStoreConformance(store, { writable })` | `load` is stable; writable: each role and key reads back typed, `None` clears back to the value before the set, a value that does not parse (through `set` or `setRole`) fails with a `SettingsError` and changes nothing; read-only: every write is refused and changes nothing | a `SettingsStore` |
| `modelCatalogConformance(catalog, { includes? })` | entries decode, each selection is `"<provider>:<modelId>"` of its own provider, no selection twice, two lists agree, the expected selections are listed | a `ModelCatalog` |

Every core kit returns `ReadonlyArray<ConformanceCheck>`. A check has a `name` and
a `run` effect that succeeds, or fails with a `ConformanceFailure` whose
`check` names the broken part of the contract and whose `message` says what
happened. The session log kits use fresh session ids and owners in every
check, so they can run against a shared database. The AuthStore kit uses fresh
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

`@xandreed/core` runs the kit over its in-memory backend, giving it its own
tree for each check:

```ts
import { Effect } from "effect"
import { fileSystemConformance, makeMemoryFileSystem } from "@xandreed/core"

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
import { fileSystemConformance } from "@xandreed/core"
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
import { bashConformance } from "@xandreed/core"
import { makeBash } from "@xandreed/plugin-workspace"

declare const temporary: Effect.Effect<string, never, Scope.Scope> // as in the FileSystem kit above

const checks = bashConformance({
  open: (planted) => Effect.all({ root: temporary, bash: makeBash({ parentEnv: { ...process.env, ...planted } }) }),
})
```

## Render kits

`@xandreed/plugin-render` exports three kits for its ports. Their checks have
the same shape, `name` and `run`, and fail with that package's own
`ConformanceFailure` (`check`, `message`) or a `RenderError`:

| Kit | Checks | Run against |
| --- | --- | --- |
| `renderSurfaceConformance(subject)` | generations opened only by changed content, completion once per version, freezing and placeholder fills, preparations one at a time, reopening, rejected components never committed, an idempotent store | a `SurfaceSubject`, whose `make(admission)` builds a fresh `Render` and `RenderStore` for each check |
| `renderFeedConformance(makeFeed)` | resuming after the cursor with one ready frame, heartbeats while idle, records in order, polling at once on a change signal | a function that builds a `RenderFeed` over a `JournalTail` (`makeMemoryJournal` gives one to append to) |
| `renderTransportConformance({ sse, socket })` | SSE and WebSocket carry identical frames | the two `RenderTransport`s |
