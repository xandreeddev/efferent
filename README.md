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
npm install effect @xandreed/sdk @xandreed/plugin-agent-loop @xandreed/plugin-models @xandreed/plugin-sessions
```

Install `effect` (4.0.7 or a later 4.x) beside them: the packages and your
code share one copy. Releases after 0.14.0 declare it a peer dependency and
each other by caret ranges, so other patch versions still install one copy of
`effect` and of `@xandreed/core`.

Every package below is published at `0.14.0` under npm's `latest` tag (npm's
older `@xandreed/plugin-telemetry` versions, 0.3.0 and 0.4.0, are an earlier,
unrelated plugin). `@xandreed/plugin-models` needs Node 24.5 or newer.
The historical `efferent` npm package is a different release line.

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

`agent.turn` returns `use`'s outcome with the turn's token `usage`: every model
call the step loop handled in the turn, input with its cache reads and writes,
output with its reasoning. [Token usage](docs/framework.md#token-usage) lists
what it leaves out (utility calls, failed or retried attempts) and what each
provider reports.

A user's message can carry images (`new UserMessage({ text, attachments })`,
built with `mediaFromBytes` or `mediaFromBase64`), and a tool can return them
as `Media` values in its result: stored inline in the session, once, checked
when they are written, and sent to the model as image parts on every route
that reads images (Anthropic, the Responses routes but Codex Spark, Gemini,
an endpoint with `images: true`); a text-only route gets a label line per
image (see [Images
and multi-part messages](docs/framework.md#images-and-multi-part-messages)
for the routes, the limits and the memory budgets).

Each turn is one trace subtree under its `agent.turn` span (a child of the
caller's span, if any; its begin is the `agent.turn.begin` beside it), its
logs carry its ids as annotations, and the packages record Effect metrics;
nothing leaves the process until the host provides an exporter. `@xandreed/plugin-telemetry` adds usage (by billed kind), cost and
tool metrics per turn (`telemetryPlugin`, with the host's prices) and exports
traces and metrics over OTLP/HTTP with Effect's own exporters
(`OtlpTelemetryLive`, or `OtlpTelemetryFromEnv` for the standard
`OTEL_EXPORTER_OTLP_*` variables), on Node 24 and Bun:

```ts
import { Effect } from "effect"
import { OtlpTelemetryLive, telemetryPlugin } from "@xandreed/plugin-telemetry"

const plugins = [/* … */ { plugin: telemetryPlugin, options: {
  prices: { "anthropic:claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, // per million tokens
} }]
declare const program: Effect.Effect<void> // defines the agent and runs its turns
Effect.runFork(program.pipe(Effect.provide(OtlpTelemetryLive({ baseUrl: "http://localhost:4318" }))))
```

See [observability](packages/website/src/content/docs/concepts/observability.md)
for the span tree, the metrics and serverless flushing.

`SessionLogMemoryLive` keeps sessions in memory and runs anywhere;
`SessionLogSqliteLive(path)` from `@xandreed/plugin-session-sqlite` stores them
in a SQLite file on Bun, and any other store can implement the `SessionLog` port.

Core ships the port contracts as conformance kits, checks any test runner can
run against your own implementation: `sessionLogConformance` and
`sessionLogRecoveryConformance` (reopening, two handles, interrupted commits,
a handle whose scope never closed) for a session store,
`sessionsConformance` (one open turn per session, keys, resume, the inbox,
leases and dead holders reaped, `TurnActivity`) for a `Sessions` backend,
`taskRunnerConformance` and `tasksConformance` for background work and
tasks, `toolRegistryConformance` (activation, concurrent `load_skill`
calls, invocation ids, the services tools declare, every `tool.refused`
reason) for a tool registry,
`memoryConformance`, `stepLoopConformance` and `turnConformance`, and
`fileSystemConformance` and `bashConformance` for the `FileSystem` and `Bash`
ports agent tools work through (`FileSystemMemoryLive` is an in-memory file
system; `FileSystemLive` and `BashLive` from `@xandreed/plugin-workspace`
are the local disk and shell, and pass both kits on Bun and Node), and for the
models plugin's ports `authStoreConformance` (an `AuthStore`: credentials read
back, resolve and refresh or fail as they should, one refresh at a time, a
logout during a refresh sticks, damaged data fails instead of reading empty),
`settingsStoreConformance` (a `SettingsStore`, writable or read-only: values
read back typed, clear, bad ones are refused, damaged data fails) and `modelCatalogConformance` (a `ModelCatalog`: valid,
unique, stable entries). See
[conformance kits](packages/website/src/content/docs/concepts/conformance.md).

### Workspace tools

`workspaceToolsPlugin` gives the model seven tools over the agent's
`workspace`: `read`, `ls`, `find` and `grep` from the first step, `write` and
`edit` once the turn holds `fs.write`, and `bash` once it holds `shell.exec`.
`localSystemPlugin` provides the disk and the shell they work through:

```ts
import { localSystemPlugin, workspaceToolsPlugin } from "@xandreed/plugin-workspace"

const agent = yield* Agent.define({
  plugins: [
    memoryWindowPlugin, stepLoopPlugin, localSystemPlugin, workspaceToolsPlugin,
    { plugin: toolDiscoveryPlugin, options: { grants: ["fs.write", "shell.exec"], maxCallsPerRun: 200 } },
  ],
  turnServices: [LanguageModel.LanguageModel],
  workspace: "/srv/checkout",
})
```

`read` returns PNG, JPEG, GIF and WebP files as images the model sees
(`readImages`, on by default). Paths stay inside the workspace (links
resolved), `write` and `edit` leave `.git` and `.efferent` alone, and
commands get an allowlisted environment without the host's keys. This is a
guardrail against mistakes, not a sandbox: `bash` can reach anything the
host process can. See [Workspace tools](docs/framework.md#workspace-tools).

Each plugin is also a typed layer (`MemoryWindowLive`, `ToolDiscoveryLive`, …)
that `stackPlugins` composes the way the graph does. A turn is public steps
over typed services (`TurnLive`, `persistMessage`, `openTurnTools`,
`runTurnLoop`, `guardTurn`): `Agent.turn` is one composition of them, and
`turnConformance` checks any other. A composable agent's conversations are
sessions: one event log each, in storage the host provides (`SessionLog`),
read and written through `@xandreed/plugin-sessions`, with an inbox and
background tasks (`@xandreed/plugin-tasks`) the agent answers after the turn
in flight. `agent.activity` (and `processActivity`, `awaitIdle`) says what
the process still has in flight, for a `/ping` or a SIGTERM drain. See
[the framework guide](docs/framework.md). Every event a turn
publishes and every kind a session's journal stores, with its payload, is in
the generated [event reference](docs/event-reference.md), with the begin and
error codes and the feed frames a host serves them with. How to use them is
the [events guide](docs/events.md): streaming a turn to a client, which
subscription sees a turn start and end, reacting to tools and refusals,
publishing your own events, following a session from another process, and
serving turns and their journal over HTTP (SSE), its snippets taken from a
test that runs.

Skills can be files: `skillsDirectoryPlugin` from `@xandreed/plugin-workspace`
reads every `SKILL.md` under `.agents/skills` (the Agent Skills layout) when
the agent is defined, and tool discovery serves them like the host's own:
the catalogue line, `load_skill` for the instructions and
`read_skill_reference` for the other files of the skill's directory.

```ts
import { localSystemPlugin, skillsDirectoryPlugin } from "@xandreed/plugin-workspace"

const plugins = [localSystemPlugin, { plugin: skillsDirectoryPlugin, options: { idPrefix: "project." } }, memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin]
```

See [skills from a directory](docs/framework.md#skills-from-a-directory)
in the framework guide for the id rule, the limits and the failure codes.

## Configuration

Plugins are configured where the agent is defined: an entry in
`Agent.define({ plugins })` is a plugin, or `{ plugin, id?, options }`. Options
merge over the plugin's defaults, nested objects key by key (an array, or an
object of another of the shapes the schema allows, replaces its default), and
decode through its schema; undeclared keys are refused.

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

The models plugin is built once per agent, and a turn's own services win over
it. By default (`storage: "local"`) it inherits existing model settings and
sign-ins from `.efferent` files; explicit plugin options take precedence, and
`inheritPrevious: false` gives an independent setup. `storage: "memory"`
never touches disk — for a server or a serverless host: credentials come from
`credentials` (`Redacted` values), the environment variables `credentialEnv`
names, or the host's `HostCredentials`, and settings edits stay in memory. See
[credentials and storage](packages/website/src/content/docs/concepts/providers.md#credentials-and-storage).

Every call the models plugin makes (the providers, OpenAI-compatible endpoints,
OAuth token refreshes, the OpenAI subscription's WebSocket) goes through its
`proxy` option, else `HTTPS_PROXY` / `HTTP_PROXY` from the environment, on Node
as on Bun; `noProxy` (added to `NO_PROXY`) and loopback hosts go direct. On
Bun, whose fetch applies a proxy from the environment by itself, only
`NO_PROXY` exempts a host from that one, so list such hosts there. See
[proxy](packages/website/src/content/docs/concepts/providers.md#proxy).

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
| `@xandreed/plugin-workspace` | The local file system and shell as `FileSystem` and `Bash` (`localSystemPlugin`), the workspace tools `read`, `write`, `edit`, `ls`, `find`, `grep` and `bash` (`workspaceToolsPlugin`), and skills from directories of `SKILL.md` files (`skillsDirectoryPlugin`); Linux and macOS |
| `@xandreed/plugin-telemetry` | Usage, cost and tool metrics per turn (`telemetryPlugin`) and OTLP/HTTP export of traces and metrics (`OtlpTelemetryLive`) |
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
package's manifest version and matching internal dependency versions,
leaving test code out. The consumer check accepts only a build of `HEAD`
from a clean tree (`--allow-dirty` accepts one of uncommitted changes). It installs local tarballs outside the monorepo, runs a
composable agent's turn, a session fork, an eval composition and a SQLite
session log with a background task on Bun, then imports every Node-capable
package on Node, and runs the `FileSystem` and `Bash` kits over the local
adapters, loads a `SKILL.md` tree through the skills directory plugin, and
runs an agent turn that reads, edits and runs a command through the
workspace tools, and flushes a turn's span and usage metric through the
telemetry plugin to a local OTLP collector, and serves a streamed turn, its
retry and its journal through the events guide's HTTP recipe, on both. It also compiles every `@xandreed/*` import in the README,
the guides and the website docs against the packed packages, and checks that
each plugin's version is its package's. `bun run docs:generate` writes the
plugin and event references, and copies the events guide's snippets from the
test that runs them into the guide and its website page.

Releases are published with `bun run publish:packages`, which checks the build
against the current commit and is a dry run unless `--publish` is passed; see
[publishing](CONTRIBUTING.md#publishing). Changes per release are in the
[changelog](CHANGELOG.md).

See [the framework guide](docs/framework.md), the
[events guide](docs/events.md), the
[event reference](docs/event-reference.md), the
[evaluation domain](docs/evaluation-domain.md) and [contributing](CONTRIBUTING.md).

MIT · Xand Reed
