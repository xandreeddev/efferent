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
npm install effect @xandreed/core @xandreed/sdk @xandreed/plugin-agent-loop @xandreed/plugin-models @xandreed/plugin-sessions @xandreed/plugin-memory-window @xandreed/plugin-tool-discovery
```

Install `effect` (4.0.7 or a later 4.x) and `@xandreed/core` beside them: the
packages and your code share one copy of each. Distribution manifests declare
both as peer dependencies and use caret ranges for other framework packages,
so compatible patch versions share them; incompatible peer versions are
reported during installation.

This guide follows repository source, including unreleased additions. Choose
the package versions and APIs available in the release you install.
`@xandreed/plugin-models` needs Node 24.5 or newer.

## Compose

```ts
import { Context, Effect, Layer, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { Agent, RunId, Sessions, SessionLogMemoryLive, TurnAdmissionOpen, UserMessage } from "@xandreed/sdk"
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
  }, (turn) => turn.run({}).pipe(Effect.map((result) => ({ outcome: result.outcome, reply: result.outcome === "waiting" ? Option.none() : Option.some(result.text) }))))
  return outcome.reply
}))
```

`@xandreed/sdk` re-exports, each by name, the part of core a host writes
beside `Agent`: a turn's message, images and ids, the sessions with their
store and admission, `defineTool`, `defineSkill`, `definePromptSection`,
`defineCapability` and `definePlugin`, the turn's events, and its errors with
their codes and guards. The rest of core (a port to implement and its
entities, memory, model requests, stored payloads) is imported from
`@xandreed/core`.

A plugin declares an Effect Schema, defaults, required/provided service tags,
and a scoped Layer. The runtime rejects invalid options, missing dependencies,
cycles, ambiguous providers, and incompatible plugin API versions before use.
Override a service through an explicit binding.

`SessionLogMemoryLive` keeps sessions in memory and runs anywhere;
`SessionLogFilesLive(path)` from `@xandreed/plugin-session-files` stores them
in a directory on Node 24 and Bun. Its directory needs exclusive hard links and
atomic renames; processes sharing it need clocks in step. A filesystem without
hard links is refused with `store.open`. Verify a shared mount with the storage
conformance/recovery kits before relying on its visibility and durability.
`SessionLogSqliteLive(path)` from `@xandreed/plugin-session-sqlite` stores them
in a SQLite file on Bun. Any other store can implement the `SessionLog` port.
See [SDK and sessions](/docs/concepts/harness/#sessions) for ownership,
durable queued input, helper questions and restart.

## Run as a child process

`@xandreed/process-host` supplies a Node 24/Bun stdio binding. The host writes
an entry module using `runProcessHost` and supplies its Agent, model, services
and session setup. The parent can send messages or steers while a turn runs,
answer helpers, cancel, ping and shut down. Progress is projected by default;
full events are opt-in. The [process protocol guide](/docs/guides/process-protocol/)
covers version negotiation, bounded input/output, durable identities and
restart; the binding adds no provider or credential setup.

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
| `@xandreed/core` | Shared schemas, ports, messages and protocol helpers; the conformance kits in `@xandreed/core/conformance` |
| `@xandreed/runtime` | Plugin graph validation and scoped activation |
| `@xandreed/sdk` | `Agent.define` and `Agent.turn`: the agent's plugin graph and its turns, over durable sessions; the turn engine; core's names a host writes beside them |
| `@xandreed/plugin-agent-loop` | The agent step loop |
| `@xandreed/plugin-models` | Model routing and provider adapters |
| `@xandreed/plugin-memory-window`, `-memory-summary`, `-memory-digest` | Conversation memory strategies and tool-result digests |
| `@xandreed/plugin-tool-discovery` | Tool and skill discovery |
| `@xandreed/plugin-sessions` | Conversation sessions, durable queued input, the turn lifecycle and optional inbox execution |
| `@xandreed/plugin-session-files` | Directory session store (Node 24 and Bun; requires hard links) |
| `@xandreed/plugin-session-sqlite` | SQLite session store (Bun) |
| `@xandreed/plugin-tasks` | Background helper tasks, durable questions and answer follow-ups |
| `@xandreed/process-host` | Host-supplied agents over versioned, bounded stdio; signals and process shutdown |
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
