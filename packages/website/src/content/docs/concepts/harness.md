---
title: Harness and SDK
description: Compose scoped plugins, durable sessions, and configurable agent hosts.
---

# Framework guide

## Runtime model

A host creates `Harness.make({ workspace, config, plugins })` inside
`Effect.scoped`. The runtime validates a dependency graph, acquires runtime
plugins once, and acquires session plugins for each open session. Finalizers
release resources in reverse dependency order. A failed activation closes its
partially acquired scope.

Each plugin has a stable `id`, `version`, `apiVersion`, `scope`, Effect Schema,
default options, required service tags, provided service tags, and Layer factory.
A plugin receives only its declared dependencies. Two providers of a service
require a `bindings` entry selecting the instance id. Runtime plugins cannot
require session services. Dependencies are checked before activation.

```ts
import { Effect, Layer, Schema } from "effect"
import { AgentLoop, definePlugin } from "@xandreed/sdk"

export default definePlugin({
  id: "example/echo",
  version: "1.0.0",
  config: Schema.Struct({ prefix: Schema.String }),
  defaults: { prefix: "Echo: " },
  provides: [AgentLoop],
  layer: ({ prefix }) => Layer.succeed(AgentLoop, {
    run: (input) => Effect.succeed({
      text: prefix + input.userMessage.text,
      outcome: "completed",
    }),
  }),
})
```

This plugin replaces the complete agent loop. No model credentials or tools
are needed to run it. `scripts/verify-packages.ts`
executes an equivalent external plugin against packed SDK artifacts.

## Configuration

Base names are `efferent.config.json` and `efferent.config.ts`; having both in
one directory is an error. Global bases live in `~/.efferent/`. TypeScript
exports a default configuration and may export `plugins: Plugin[]` containing
local definitions. JSON resolves `use: "./my-plugin.ts"` or an installed package.
Only trusted configuration modules should be loaded: TypeScript executes code.

The merge order is preset, global base, workspace base, selected profile,
`.efferent/overrides.json`, then invocation. Plugin entries merge by instance
`id`; options merge by key. Changing `use` replaces the prior instance options.
Profile maps and bindings merge by key. An unknown profile is an error.

`harness.reconfigure(config)` validates and stages the next graph before making
it available. Idle sessions refresh; active sessions refresh before their next
turn. A changed runtime graph returns `restart-required`; the host decides when
to restart. Source TypeScript configuration is never rewritten.

## Sessions

The harness and composable agents share `SessionLog` and `Sessions`. The
deprecated `SessionStore` and `ConversationStore` APIs are projections over
that journal. Compose a storage plugin with `sessionsPlugin`; single-host
deployments use process ownership (a live process's turn is busy to another process
on the same host), while hosts sharing a database across machines use leases.
Without `sessionsPlugin`, `Harness.make` fails with `service.missing` naming it;
a custom `SessionStore` must be the projection over the same `SessionLog`, or
the turn fails with `session.store`.

- `create`, `resume`, `list`, and `fork` use the unified session heads and
  immutable history boundaries. A fork cut within inherited history keeps
  the exact prefix, logical parent and inherited turn counter.
- `send` journals input, admits through `Sessions.begin` and writes through
  `TurnWriter` before ending the turn; `steer` queues input for a loop's
  next admission boundary; `continue` resumes the pending queue. Input
  submitted while a turn is ending is still queued.
- `use(Service, callback)` accesses a selected domain service while holding the
  session gate; resource disposal waits until the callback completes.
- `interrupt` cancels the active fiber. The run settles once as cancelled, and
  so does a turn cancelled or reaped by another instance, even if its loop
  returns successfully without another write.
- `events(after)` replays durable events after an exclusive cursor, then follows
  the journal. Notifications can coalesce; journal entries are not dropped.
- `transient` carries bounded, disposable text deltas. It is not replay storage.
- A reopened unfinished run is marked cancelled. Tools are never rerun merely
  because a client reconnects. A run still held, by its lease or by a process
  that still runs, is left alone. A fork
  requires a settled event boundary. Refused admission leaves input unclaimed.

Session plugins can require `SessionEnvironment` to access the workspace and
current session record. `domainLoop` and `domainSession` bridge an existing domain
event protocol to SDK lifecycle and replay; optional snapshots restore domain
state when a session is forked. Conversation writes carry their originating
run's token: a detached write from an earlier run stays refused even during a
later run. During execution, external closure is noticed at the writer's next
commit; settlement also checks the durable ending when the loop returns.

The SQLite plugin uses WAL and transactional sequence allocation. The memory
plugin uses a workspace-scoped append-only JSONL ledger. The default new data
namespace is `.efferent/runtime`. Existing SQLite journal tables are imported
once into the unified tables while preserving the originals. `legacyPaths`
imports separate older files through read-only connections. Sessions are
matched by id, not by path: a moved or copied source neither duplicates
records nor brings back removed or pruned sessions, and orphan message rows
join the session stored under their id. Undecodable rows are skipped and
logged; conflicting owners or positions refuse the entire source. Stop older
application versions before migrating, because subsequent old-version writes
are not mirrored.
The models plugin reads existing model settings and credentials as fallbacks by
default. Explicit plugin options and current credentials win. Set its
`inheritPrevious` option to `false` to use an independent setup; new logins and
refreshed inherited credentials are written to the current credential store.

## Evals

`@xandreed/evals` models tasks, trials, transcripts, observed outcomes, runnables, graders and suites. Applications provide the execution/environment adapters and grading-context projections. A calibration measures a grader against labelled examples; ordinary model comparisons are suites. The local Node CLI and optional Langfuse/LangSmith exporters are separate packages. See [Evaluation domain and adapters](/docs/concepts/evals/) for the interfaces and workflow.

## Sessions for composable agents

A composable agent (`Agent.define`) keeps each conversation as a session: one
append-only event log holding its turns, memory, events, host records, inbox
and background tasks. The host provides the storage (`SessionLog`: a head
per session and its events, written by compare-and-swap; Efferent ships an
in-memory and a SQLite log) and reads and writes sessions only through
`@xandreed/plugin-sessions`, as `Agent.turn` does. One turn is open per
session at a time; a second message is refused, a retried one is found by
its key. Turns are owned by a lease judged by the storage's clock (several
instances) or by the process that began them, for as long as it runs (one
host). Reading or following a session never runs anything.

`Agent.turn` closes the body scope, the host's layer, then the plugins that
depend on turn services. On success, tasks and background reactions settle
between these dependency boundaries while `TurnLive` remains open. A completed
reply is recorded only after finalizer work settles; a finalizer task failure
produces a failed reply. Failure or interruption preserves the cause, and
closing the turn's scope interrupts pending tasks. Subscriptions in those
closing scopes cannot observe the final outcome: register an outcome observer
in the caller's outer scope with `Scope.provide(observerScope)` and services
that remain open there.

A background task (`@xandreed/plugin-tasks`) is one turn of a child session,
a fork of the conversation or a fresh spawn, run by the host's `TaskRunner`.
Its result lands in the parent's inbox once, and the parent answers it after
the turn in flight. See the framework guide's sessions section for the
contract, the event vocabulary and the inbox protocol.

## Distribution

`bun run build:packages` creates JavaScript, declarations and versioned manifests
under `.artifacts/packages`. `bun run verify:packages` packs them, installs them
in a temporary external project through a temporary local npm registry, and exercises
SDK sessions, replacement plugins, persistence, forks and custom evals on Bun,
then imports every Node-capable package on Node. Publishing is a separate release action.
