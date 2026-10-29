# Efferent

**Compose the agent. Own the harness.**

An Effect-native agent framework for Node 24 and Bun. The model, agent loop,
memory, sessions, tool discovery, background tasks and rendering are
configurable plugins. The SDK composes them into one validated graph.

This repository holds the framework only. The coding CLI and the reference
applications are moving to their own repositories; until then they live in
this repository's history.

## Install

```sh
npm install @xandreed/sdk @xandreed/plugin-agent-loop @xandreed/plugin-models @xandreed/plugin-sessions
```

Every package below is published at `0.13.0` under npm's `latest` tag. The
historical `efferent` npm package is a different release line.

## Compose

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

A plugin declares an Effect Schema, defaults, required/provided service tags,
and a scoped Layer. The runtime rejects invalid options, missing dependencies,
cycles, ambiguous providers, and incompatible plugin API versions before use.
Override a service through an explicit binding.

`agent.turn` returns `use`'s outcome with the turn's token `usage`: every model
call the step loop handled in the turn, input with its cache reads and writes,
output with its reasoning. [Token usage](docs/framework.md#token-usage) lists
what it leaves out (utility calls, failed or retried attempts) and what each
provider reports.

`SessionLogMemoryLive` keeps sessions in memory and runs anywhere;
`SessionLogSqliteLive(path)` from `@xandreed/plugin-session-sqlite` stores them
in a SQLite file on Bun, and any other store can implement the `SessionLog` port.

Core ships the port contracts as conformance kits, checks any test runner can
run against your own implementation: `sessionLogConformance` and
`sessionLogRecoveryConformance` (reopening, two handles, interrupted commits,
a handle whose scope never closed) for a session store,
`memoryConformance`, `stepLoopConformance` and `turnConformance`. See
[conformance kits](packages/website/src/content/docs/concepts/conformance.md).

Each plugin is also a typed layer (`MemoryWindowLive`, `ToolDiscoveryLive`, …)
that `stackPlugins` composes the way the graph does. A turn is public steps
over typed services (`TurnLive`, `persistMessage`, `openTurnTools`,
`runTurnLoop`, `guardTurn`): `Agent.turn` is one composition of them, and
`turnConformance` checks any other. A composable agent's conversations are
sessions: one event log each, in storage the host provides (`SessionLog`),
read and written through `@xandreed/plugin-sessions`, with an inbox and
background tasks (`@xandreed/plugin-tasks`) the agent answers after the turn
in flight. See [the framework guide](docs/framework.md). Every event a turn
publishes and every kind a session's journal stores, with its payload, is in
the generated [event reference](docs/event-reference.md), with the begin and
error codes and the feed frames a host serves them with.

## Configuration

Plugins are configured where the agent is defined: an entry in
`Agent.define({ plugins })` is a plugin, or `{ plugin, id?, options }`. Options
merge over the plugin's defaults and decode through its schema; undeclared keys
are refused.

To use any OpenAI-compatible server — a local model or a self-hosted gateway,
with or without a key — name it under the models plugin's `endpoints` and select
`<name>:<model id>`:

```ts
{ plugin: modelsPlugin, options: {
  model: "local:llama3.1:8b",
  endpoints: { local: { url: "http://localhost:11434/v1" } },
} }
```

The key comes from `apiKey`, the environment variable `apiKeyEnv` names, or a
stored key; with none, no `Authorization` header is sent. See
[plugin configuration](packages/website/src/content/docs/concepts/providers.md#model-endpoints).

The models plugin inherits existing model settings and sign-ins by
default; explicit plugin options take precedence. Set `inheritPrevious: false`
for an independent setup.

## Packages

| Package | Responsibility |
| --- | --- |
| `@xandreed/core` | Shared schemas, ports, messages and protocol helpers |
| `@xandreed/runtime` | Plugin graph validation and scoped activation |
| `@xandreed/sdk` | `Agent.define` and `Agent.turn`: the agent's plugin graph and its turns, over durable sessions |
| `@xandreed/plugin-agent-loop` | The agent step loop |
| `@xandreed/plugin-models` | Model routing and provider adapters |
| `@xandreed/plugin-memory-window`, `-memory-summary`, `-memory-digest` | Conversation memory strategies and tool-result digests |
| `@xandreed/plugin-tool-discovery` | Tool and skill discovery |
| `@xandreed/plugin-sessions` | Conversation sessions and the turn lifecycle |
| `@xandreed/plugin-session-sqlite` | SQLite session store (Bun only) |
| `@xandreed/plugin-tasks` | Background tasks |
| `@xandreed/plugin-render` | Render surfaces, event feeds and streaming |
| `@xandreed/evals` | Tasks, trials, graders and suites; app adapters, local reports and retrieval metrics |
| `@xandreed/evals-cli` | The `efferent-eval` command line (Node 24) |
| `@xandreed/evals-langfuse`, `@xandreed/evals-langsmith` | Optional evaluation exporters (Node 24) |

`packages/foundry` (the deterministic verification framework behind
`bun run typecheck`) and `packages/website` (the docs site) are development
tooling and are not published.

## Build and verify

```sh
bun install
bun run typecheck
bun test
bun run foundry demo
bun run build:packages
bun run verify:packages
bun run --cwd packages/website check
```

The distribution build prepares artifacts under `.artifacts/` using each
package's manifest version and matching internal dependency versions.
The consumer check installs local tarballs outside the monorepo, runs a
composable agent's turn, a session fork, an eval composition and a SQLite
session log with a background task on Bun, then imports every Node-capable
package on Node. It also compiles every `@xandreed/*` import in the README,
the guides and the website docs against the packed packages, and checks that
each plugin's version is its package's. `bun run docs:generate` writes the
plugin and event references.

Releases are published with `bun run publish:packages`, which checks the build
against the current commit and is a dry run unless `--publish` is passed; see
[publishing](CONTRIBUTING.md#publishing). Changes per release are in the
[changelog](CHANGELOG.md).

See [the framework guide](docs/framework.md), the
[event reference](docs/event-reference.md), the
[evaluation domain](docs/evaluation-domain.md) and [contributing](CONTRIBUTING.md).

MIT · Xand Reed
