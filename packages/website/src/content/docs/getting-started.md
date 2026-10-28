---
title: Getting started
description: Build a composable agent with the Efferent SDK and its first-party plugins.
---

# Efferent

**Compose the agent. Own the harness.**

An Effect-native agent framework for Node 24 and Bun. The model, agent loop,
memory, sessions, tool discovery, background tasks and rendering are
configurable plugins. The SDK composes them into one validated graph.

## Install

Install the SDK and the plugins your application uses:

```sh
npm install @xandreed/sdk @xandreed/plugin-agent-loop @xandreed/plugin-models @xandreed/plugin-sessions
```

All framework packages are published at `0.12.0` under npm's `latest` tag.

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
Replace the loop, memory or any other service through an explicit binding.

The SQLite session store uses `bun:sqlite`, so this example runs on Bun. On
Node, provide the `SessionLog` port from `@xandreed/core` with your own store,
or with `SessionLogMemoryLive` for an in-memory log.

## Configuration

Configuration is JSON or TypeScript and resolves through the same plugin graph.
Each entry names an instance, the plugin it uses, and its options:

```json
{
  "version": 1,
  "plugins": [
    { "id": "memory", "use": "@xandreed/plugin-memory", "options": { "limit": 6 } },
    { "id": "loop", "use": "@xandreed/plugin-agent-loop", "options": { "maxSteps": 40 } }
  ]
}
```

The [plugin reference](/docs/concepts/plugin-reference/) lists every
first-party plugin with its defaults and configuration schema.

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
| `@xandreed/plugin-session-sqlite` | SQLite session store (Bun) |
| `@xandreed/plugin-tasks` | Background tasks |
| `@xandreed/plugin-render` | Render surfaces, event feeds and streaming |
| `@xandreed/evals`, `-evals-cli`, `-evals-langfuse`, `-evals-langsmith` | Tasks, trials, graders and suites; the `efferent-eval` CLI; exporters (Node 24) |

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
package's manifest version and matching internal dependency versions. The
consumer check installs local tarballs outside the monorepo, runs an external
loop plugin with durable sessions, a fork and an eval composition on Bun, and
imports every Node-capable package on Node.

See [the framework guide](/docs/concepts/harness/) and the
[source and contributing guide](https://github.com/xandreeddev/efferent).

MIT · Xand Reed
