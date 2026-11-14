# Efferent

**Compose the agent. Own the harness.**

An Effect-native agent framework for Node 24 and Bun. The model, agent loop,
memory, sessions, tool discovery, background tasks and rendering are plugins
the SDK composes into one validated graph.

**[Documentation](https://xandreeddev.github.io/efferent/docs/)** · [Getting started](https://xandreeddev.github.io/efferent/docs/getting-started/) · [Plugins](https://xandreeddev.github.io/efferent/docs/plugins/) · [Changelog](CHANGELOG.md)

## Install

```sh
npm install effect @xandreed/core @xandreed/sdk @xandreed/plugin-agent-loop @xandreed/plugin-models @xandreed/plugin-sessions @xandreed/plugin-memory-window @xandreed/plugin-tool-discovery
```

`effect` (4.x) and `@xandreed/core` are peer dependencies: your code and the
packages share one copy of each. `@xandreed/plugin-models` needs Node 24.5 or newer.
Workspace packages share version `0.22.0`.

## Hello, agent

```ts
import { Context, Effect, Layer, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { Agent, RunId, Sessions, SessionLogMemoryLive, TurnAdmissionOpen, UserMessage } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"

declare const model: LanguageModel.LanguageModel // from @xandreed/plugin-models or any effect/ai provider

const reply = Effect.scoped(
  Effect.gen(function* () {
    // Sessions over an in-memory journal that admits every turn.
    const sessionsLayer = SessionsPluginLive({ ownership: { mode: "process" } }).pipe(
      Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
    )
    const sessions = Context.get(yield* Layer.build(sessionsLayer), Sessions)

    const agent = yield* Agent.define({
      plugins: [
        { plugin: memoryWindowPlugin, options: { digestOnWriteChars: 4_000 } },
        toolDiscoveryPlugin,
        stepLoopPlugin,
      ],
      turnServices: [LanguageModel.LanguageModel],
      system: "You are a helpful assistant.",
    })

    const view = yield* sessions.create({ owner: "user-1" })
    const outcome = yield* agent.turn(
      {
        turn: {
          session: { id: view.header.id, owner: "user-1" },
          userMessage: new UserMessage({ text: "Hello" }),
          runId: RunId.make(crypto.randomUUID()),
        },
        services: Context.merge(
          Context.make(LanguageModel.LanguageModel, model),
          Context.make(Sessions, sessions),
        ),
      },
      (turn) =>
        turn.run({}).pipe(
          Effect.map((result) => ({
            outcome: result.outcome,
            reply: result.outcome === "waiting" ? Option.none() : Option.some(result.text),
          })),
        ),
    )
    return outcome.reply
  }),
)
```

`agent.turn` runs one turn of a durable session through the plugins you chose.
The [getting started guide](https://xandreeddev.github.io/efferent/docs/getting-started/) walks through it; the
[harness](https://xandreeddev.github.io/efferent/docs/concepts/harness/) explains turns, services and outcomes.

## Learn more

- [Learn](https://xandreeddev.github.io/efferent/learn/): build an agent on the kernel, step by step, in your browser
- [The kernel](docs/kernel.md): the smaller core beside the engine, its contracts and plugins, and what is still open
- [Architecture](https://xandreeddev.github.io/efferent/docs/concepts/architecture/): ports, plugins and the plugin graph
- [Models and providers](https://xandreeddev.github.io/efferent/docs/concepts/providers/): endpoints, credentials, proxies
- [Events](https://xandreeddev.github.io/efferent/docs/guides/events/): streaming a turn to a client
- [Memory and RAG](https://xandreeddev.github.io/efferent/docs/concepts/native-knowledge/): cross-conversation memory and cited retrieval
- [Workspace](https://xandreeddev.github.io/efferent/docs/concepts/workspace/): file system, shell and skills from a directory
- [Observability](https://xandreeddev.github.io/efferent/docs/concepts/observability/) and [evaluations](https://xandreeddev.github.io/efferent/docs/concepts/evals/)
- [Plugin reference](https://xandreeddev.github.io/efferent/docs/concepts/plugin-reference/): every plugin's options

## Packages

| Package | What it is |
| --- | --- |
| `@xandreed/core` | Schemas, ports, messages and the conformance kits |
| `@xandreed/runtime` | Plugin graph validation and activation |
| `@xandreed/sdk` | `Agent.define`, `agent.turn` and the turn engine |
| `@xandreed/process-host` | Run an agent behind a stdio protocol |
| `@xandreed/plugin-agent-loop` | The step loop |
| `@xandreed/plugin-models` | Model routing and providers |
| `@xandreed/plugin-memory-window`, `-memory-summary`, `-memory-digest` | Conversation memory strategies |
| `@xandreed/plugin-memory`, `@xandreed/plugin-rag` | Long-term memory and cited document retrieval |
| `@xandreed/plugin-knowledge-postgres` | PostgreSQL and pgvector storage for memory and documents |
| `@xandreed/plugin-tool-discovery` | Tool and skill discovery |
| `@xandreed/plugin-sessions`, `-session-files`, `-session-sqlite` | Sessions and their stores |
| `@xandreed/plugin-tasks` | Background tasks |
| `@xandreed/plugin-render` | Render surfaces, feeds and streaming |
| `@xandreed/plugin-workspace` | File system, shell and workspace tools |
| `@xandreed/plugin-telemetry` | Usage, cost and OTLP export |
| `@xandreed/evals`, `@xandreed/evals-cli`, `@xandreed/evals-langfuse`, `@xandreed/evals-langsmith` | Evaluations, their CLI and exporters |

## Contributing

```sh
bun install
bun run verify
```

See [contributing](CONTRIBUTING.md) for the full checks and how releases work.

MIT · Xand Reed
