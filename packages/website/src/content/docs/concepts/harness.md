---
title: SDK and sessions
description: Define an agent from plugins, run its turns, and keep each conversation as a durable session.
---

# SDK and sessions

## Defining an agent

`Agent.define(config)` (from `@xandreed/sdk`) resolves the plugin graph and
activates its runtime plugins once, in the caller's scope. Each turn then runs
through `agent.turn`, with the turn's own services: the model, the `Sessions`
it is written to, and any per-turn host data.

```ts
import { Context, Effect, Layer, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { Sessions, SessionLogMemoryLive, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import { Agent } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"

declare const model: LanguageModel.LanguageModel // from @xandreed/plugin-models or any effect/ai provider

const reply = Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(
    Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
  )), Sessions)
  const agent = yield* Agent.define({
    plugins: [{ plugin: memoryWindowPlugin, options: { digestOnWriteChars: 4_000 } }, toolDiscoveryPlugin, stepLoopPlugin],
    turnServices: [LanguageModel.LanguageModel],
    system: "You are a helpful assistant.",
  })
  const view = yield* sessions.create({ owner: "user-1" })
  const outcome = yield* agent.turn({
    turn: { session: { id: view.header.id, owner: "user-1" }, userMessage: new UserMessage({ text: "Hello" }), runId: crypto.randomUUID() },
    services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)),
  }, (turn) => turn.run({}).pipe(Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
  return outcome.reply
}))
```

`agent.turn` returns what `use` returned with the turn's token usage
(`outcome.usage`: every model call the step loop handled in the turn, cache
reads and writes and reasoning included). [Token usage](/docs/concepts/providers/#token-usage)
lists what it leaves out (utility calls, failed or retried attempts).

A new turn may carry the host's metadata, `meta` (a request id, a tenant):
`turn: { session, userMessage, runId, key, meta }`. It is stored with the
turn's start, given to the host's `TurnAdmission`, and shown on
`turn.admitted`, `RunContext.admitted` and the `turn.started` event. The
model never sees it, and a retry with the same key and other metadata is
still the same turn (`turn.duplicate`).

The turn's stored end says how it ended: completed, partial or failed as
`use` returned it; failed with the error's own code (a `HarnessError`'s),
`turn.failed` (an error without a code) or `turn.defect`; or interrupted,
with `turn.interrupted`. `turnEndingOf(exit)` from `@xandreed/core` gives
that ending, for a host that ends turns itself. If storing the end of a
successful turn fails, the turn fails; an end that could not be stored is
tried again, with the same ending, when the writer's scope closes.

`budgetTokens` (on the agent, or per run in the policy; 64 000 by default)
is the target memory keeps each request under: the system prompt, the tool
schemas and the messages, estimated. It must be an integer of at least 1
(`config.budget`, `turn.budget`). At each step, what the system prompt and
tool schemas leave of it is what the memory strategy fits the messages
into; when they leave nothing, the step fails with `context.budget`. Every
step's `context.built` event records it. The [event reference](/docs/concepts/event-reference/)
lists the framework's stored failure codes; a turn that fails with a
host's or a plugin's error stores that error's code.

`SessionLogMemoryLive` keeps sessions in memory and runs anywhere.
`SessionLogSqliteLive(path)` from `@xandreed/plugin-session-sqlite` stores
them in a SQLite file on Bun; any other store can implement the `SessionLog`
port.

## Plugins

Each plugin has a stable `id`, `version`, `apiVersion`, `scope`, Effect Schema,
default options, required service tags, provided service tags, and Layer factory.
A plugin receives only its declared dependencies. Two providers of a service
require a `bindings` entry selecting the instance id. Runtime plugins cannot
require session services. Dependencies are checked before activation, and a
failed activation closes its partially acquired scope.

Options are given as `{ plugin, options }` entries in `Agent.define({ plugins })`.
They merge over the plugin's defaults and decode through its schema;
undeclared keys are refused. The [plugin reference](/docs/concepts/plugin-reference/)
lists every first-party plugin's defaults and schema.

## Sessions

A composable agent keeps each conversation as a session: one append-only
event log holding its turns, memory, events, host records, inbox and
background tasks. The host provides the storage (`SessionLog`: a head per
session and its events, written by compare-and-swap) and reads and writes
sessions only through `@xandreed/plugin-sessions`, as `Agent.turn` does. One
turn is open per session at a time; a second message is refused, a retried
one is found by its key. Turns are owned by a lease judged by the storage's
clock (several instances) or by the process that began them, for as long as
it runs (one host). The storage's clock is the backend's: the memory and
SQLite logs read the committing process's Effect `Clock`, under the write
lock, so instances sharing a lease over them need clocks in step; a host's
own store may read its server's clock instead. Reading or following a session never runs anything.

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

The models plugin reads existing model settings and credentials as fallbacks by
default. Explicit plugin options and current credentials win. Set its
`inheritPrevious` option to `false` to use an independent setup.

## Evals

`@xandreed/evals` models tasks, trials, transcripts, observed outcomes, runnables, graders and suites. Applications provide the execution/environment adapters and grading-context projections. A calibration measures a grader against labelled examples; ordinary model comparisons are suites. The local Node CLI and optional Langfuse/LangSmith exporters are separate packages. See [Evaluation domain and adapters](/docs/concepts/evals/) for the interfaces and workflow.

## Distribution

`bun run build:packages` creates JavaScript, declarations and versioned manifests
under `.artifacts/packages`. `bun run verify:packages` packs them, installs them
in a temporary external project through a temporary local npm registry, runs a
composable agent's turn, a session fork, sessions over SQLite with a background
task and custom evals on Bun, then imports every Node-capable package on Node.
Publishing is a separate release action.
