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

Every package below is published at `0.11.0` under npm's `latest` tag. The
historical `efferent` npm package is a different release line.

## Compose

```ts
import { Effect, Layer, Schema } from "effect"
import { AgentLoop, definePlugin, Harness } from "@xandreed/sdk"
import sessions from "@xandreed/plugin-session-sqlite"
import { sessionsPlugin } from "@xandreed/plugin-sessions"

const echo = definePlugin({
  id: "example/echo", version: "1",
  config: Schema.Struct({ prefix: Schema.String }), defaults: { prefix: "hello " },
  provides: [AgentLoop],
  layer: ({ prefix }) => Layer.succeed(AgentLoop, {
    run: (input) => Effect.succeed({ text: prefix + input.userMessage.text, outcome: "completed" }),
  }),
})

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const harness = yield* Harness.make({
    workspace: process.cwd(),
    plugins: [sessions, sessionsPlugin, echo],
    config: { version: 1, plugins: [
      { id: "store", use: sessions.id },
      { id: "session-service", use: sessionsPlugin.id, options: { ownership: { mode: "process" } } },
      { id: "loop", use: echo.id },
    ] },
  })
  const session = yield* harness.create()
  yield* session.send("world")
  console.log(yield* session.history)
})))
```

A plugin declares an Effect Schema, defaults, required/provided service tags,
and a scoped Layer. The runtime rejects invalid options, missing dependencies,
cycles, ambiguous providers, and incompatible plugin API versions before use.
Override a service through an explicit binding.

The SQLite session store uses `bun:sqlite`, so this example runs on Bun. On
Node, provide the `SessionLog` port from `@xandreed/core` with your own store,
or with `SessionLogMemoryLive` for an in-memory log.

Each plugin is also a typed layer (`MemoryWindowLive`, `ToolDiscoveryLive`, …)
that `stackPlugins` composes the way the graph does. A turn is public steps
over typed services (`TurnLive`, `persistMessage`, `openTurnTools`,
`runTurnLoop`, `guardTurn`): `Agent.turn` is one composition of them, and
`turnConformance` checks any other. A composable agent's conversations are
sessions: one event log each, in storage the host provides (`SessionLog`),
read and written through `@xandreed/plugin-sessions`, with an inbox and
background tasks (`@xandreed/plugin-tasks`) the agent answers after the turn
in flight. See [the framework guide](docs/framework.md).

## Configuration

Configuration is `efferent.config.json` or `efferent.config.ts`; both resolve
through the same graph. TypeScript can additionally export a `plugins` array.
JSON can refer to local modules or installed npm plugins through `use`.

```json
{
  "version": 1,
  "plugins": [
    { "id": "memory", "use": "@xandreed/plugin-memory", "options": { "limit": 6 } },
    { "id": "loop", "use": "@xandreed/plugin-agent-loop", "options": { "maxSteps": 40 } }
  ]
}
```

Session plugin changes apply between turns; runtime plugin changes require a
restart. The models plugin inherits existing model settings and sign-ins by
default; explicit plugin options take precedence. Set `inheritPrevious: false`
for an independent setup.

## Packages

| Package | Responsibility |
| --- | --- |
| `@xandreed/core` | Shared schemas, ports, messages and protocol helpers |
| `@xandreed/runtime` | Config loading, plugin graph validation and scoped activation |
| `@xandreed/sdk` | Durable sessions, queues, cancellation, replay and forks |
| `@xandreed/plugin-agent-loop` | The agent step loop |
| `@xandreed/plugin-models` | Model routing and provider adapters |
| `@xandreed/plugin-memory`, `-memory-window`, `-memory-summary`, `-memory-digest` | Conversation memory strategies |
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
The consumer check installs local tarballs outside the monorepo, runs an
external loop plugin, durable sessions, a fork, an eval composition and a SQLite
session log with a background task on Bun, then imports every Node-capable
package on Node.

See [the framework guide](docs/framework.md), the
[evaluation domain](docs/evaluation-domain.md) and [contributing](CONTRIBUTING.md).

MIT · Xand Reed
