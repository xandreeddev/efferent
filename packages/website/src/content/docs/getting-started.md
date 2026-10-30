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
npm install effect @xandreed/sdk @xandreed/plugin-agent-loop @xandreed/plugin-models @xandreed/plugin-sessions
```

Install `effect` (4.0.7 or a later 4.x) beside them: the packages and your
code share one copy. Releases after 0.14.0 declare it a peer dependency and
each other by caret ranges, so other patch versions still install one copy of
`effect` and of `@xandreed/core`.

All framework packages are published at `0.14.0` under npm's `latest` tag.
`@xandreed/plugin-models` needs Node 24.5 or newer.

## Compose

```ts
import { Context, Effect, Layer, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { RunId, Sessions, SessionLogMemoryLive, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
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
    turn: { session: { id: view.header.id, owner: "user-1" }, userMessage: new UserMessage({ text: "Hello" }), runId: RunId.make(crypto.randomUUID()) },
    services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)),
  }, (turn) => turn.run({}).pipe(Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
  return outcome.reply
}))
```

A plugin declares an Effect Schema, defaults, required/provided service tags,
and a scoped Layer. The runtime rejects invalid options, missing dependencies,
cycles, ambiguous providers, and incompatible plugin API versions before use.
Override a service through an explicit binding.

`SessionLogMemoryLive` keeps sessions in memory and runs anywhere;
`SessionLogSqliteLive(path)` from `@xandreed/plugin-session-sqlite` stores them
in a SQLite file on Bun, and any other store can implement the `SessionLog` port.

## Configuration

Plugins are configured where the agent is defined: an entry in
`Agent.define({ plugins })` is a plugin, or `{ plugin, id?, options }`. Options
merge over the plugin's defaults, nested objects key by key (an array, or an
object of another of the shapes the schema allows, replaces its default), and
decode through its schema; undeclared keys are refused. The [plugin reference](/docs/concepts/plugin-reference/) lists every
first-party plugin with its defaults and configuration schema, and
[plugin configuration](/docs/concepts/providers/#model-endpoints) shows how to
point the models plugin at any OpenAI-compatible endpoint.

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
| `@xandreed/plugin-session-sqlite` | SQLite session store (Bun) |
| `@xandreed/plugin-tasks` | Background tasks |
| `@xandreed/plugin-render` | Render surfaces, event feeds and streaming |
| `@xandreed/plugin-workspace` | The local file system and shell as `FileSystem` and `Bash` (`localSystemPlugin`), the [workspace tools](/docs/concepts/workspace) `read`, `write`, `edit`, `ls`, `find`, `grep` and `bash` (`workspaceToolsPlugin`), and skills from directories of `SKILL.md` files (`skillsDirectoryPlugin`); Linux and macOS |
| `@xandreed/plugin-telemetry` | Usage, cost and tool metrics per turn and OTLP/HTTP export of traces and metrics ([observability](/docs/concepts/observability/)) |
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
package's manifest version and matching internal dependency versions,
leaving test code out. The consumer check accepts only a build of `HEAD`
from a clean tree (`--allow-dirty` accepts one of uncommitted changes). It
installs local tarballs outside the monorepo, runs a
composable agent's turn, a session fork and an eval composition on Bun,
imports every Node-capable package on Node, runs the `FileSystem` and
`Bash` kits over the local adapters of `@xandreed/plugin-workspace`, loads a
`SKILL.md` tree through the packed skills directory plugin, and runs an agent
turn that reads, edits and runs a command through the workspace tools, and
exports a turn's span and usage metric through `@xandreed/plugin-telemetry`
to a local OTLP collector, on both.

See [the framework guide](/docs/concepts/harness/) and the
[source and contributing guide](https://github.com/xandreeddev/efferent).

MIT · Xand Reed
