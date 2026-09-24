---
title: Getting started
description: Run the coding terminal and build a composable agent with Efferent.
---

# Efferent

**Compose the agent. Own the harness.**

An Effect-native agent SDK and coding terminal for Bun on Linux. The model,
agent loop, tools, policy, context, memory, persistence, MCP, and telemetry are
configurable plugins. Smith is the coding preset; the SDK also runs headlessly.

## Start

```sh
bun install
bun run efferent
```

When no model is configured, the setup screen opens automatically. Use `/setup`
to return to provider login, model selection, and plugin configuration at any time.
`/login` connects an API key or subscription; `/model` shows available models.

Type `/` to see commands immediately, keep typing to filter, use ↑↓ to select,
Enter to run, or Tab to complete a command before adding arguments. Ctrl+P opens
the full command palette. Enter sends; Alt+Enter adds a line; Escape interrupts.
`/plan` enables read-only tools.

Use `/plugins` → select an instance → **Replace plugin…** to swap its implementation.
Choose an available replacement or **Use another plugin…** for a local module
or installed package. Efferent validates the resulting graph before saving; a
failed replacement keeps the current configuration. The replacement uses its
own default settings. Edit its options from the same menu afterward.
Bubblewrap is required for sandboxed Bash (`bun run efferent doctor`).

```sh
bun run efferent -p "Explain this repository" --json
bun run efferent config explain
bun run efferent --resume SESSION_ID
```

## Compose

```ts
import { Effect } from "effect"
import { Harness } from "@xandreed/sdk"
import { smithAgent } from "@xandreed/smith"

const agent = smithAgent(process.cwd())
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const harness = yield* Harness.make({
    workspace: process.cwd(), config: agent.config, plugins: agent.plugins,
  })
  const session = yield* harness.create()
  yield* session.send("Explain the architecture")
  console.log(yield* session.history)
})))
```

A plugin declares an Effect Schema, defaults, required/provided service tags,
and a scoped Layer. The runtime rejects invalid options, missing dependencies,
cycles, ambiguous providers, and incompatible plugin API versions before use.
Override a service through an explicit binding; replace the loop or memory
without importing Smith or the TUI.

## Configuration

Choose `efferent.config.json` or `efferent.config.ts` per directory. Both resolve
through the same graph. TypeScript can additionally export a `plugins` array.
JSON can refer to local modules or installed npm plugins through `use`.

```json
{
  "version": 1,
  "profile": "smith",
  "plugins": [
    { "id": "memory", "use": "@xandreed/plugin-memory", "options": { "limit": 6 } },
    { "id": "loop", "use": "@xandreed/plugin-agent-loop", "options": { "maxSteps": 40 } }
  ]
}
```

Order: preset → global base → workspace base → profile → workspace overrides →
invocation. `/plugins` writes `.efferent/overrides.json` atomically. Session plugin
changes apply between turns; runtime plugin changes require a restart.

New sessions and memory live under `.efferent/runtime/`. Existing databases,
auth files, specs, and memory are retained. The models plugin inherits existing
model settings and sign-ins by default; explicit plugin options take precedence.
Set `inheritPrevious: false` for an independent setup.

## Packages

| Package | Responsibility |
| --- | --- |
| `@xandreed/core` | Shared schemas, ports, messages and protocol helpers |
| `@xandreed/runtime` | Config loading, plugin graph validation and scoped activation |
| `@xandreed/sdk` | Durable sessions, queues, cancellation, replay and forks |
| `@xandreed/plugin-*` | Replaceable first-party capabilities |
| `@xandreed/smith` | Coding preset and optional spec/forge modules |
| `@xandreed/tui` / `@xandreed/cli` | Reusable terminal client and application entry |
| `@xandreed/evals` | Scoped fixtures, checks, judges, campaigns and reporters |
| `@xandreed/foundry` | Independent deterministic verification framework |

Canvas, Math and Social are reference applications with domain-specific checks.
Their browser and review interfaces remain available through `bun run canvas`,
`bun run math`, and `bun run social`. All three enter through SDK presets.

Use `/spec idea`, `/lock`, and `/forge` for gated workflows in the new terminal. The historical spec/forge driver is
available through `bun run smith:workflow` for old specs.

## Build and verify

```sh
bun run typecheck
bun test
bun run foundry demo
bun run scenarios
bun run build:packages
bun run verify:packages
python scripts/verify-tui.py
python scripts/verify-tmux.py
bun run --cwd packages/website check
```

The distribution build prepares artifacts under `.artifacts/` using each
package's manifest version and matching internal dependency versions.
The consumer check installs local tarballs outside the monorepo, then executes
an external loop plugin, durable sessions, a fork, an eval and CLI startup.
`@xandreed/core`, `@xandreed/evals`, `@xandreed/runtime`, `@xandreed/sdk`, and
all nine `@xandreed/plugin-*` packages are published as `0.3.0` under npm's
`latest` tag. Install evals with `npm install @xandreed/evals`, or install the
SDK and the plugins your application uses, for example:

```sh
npm install @xandreed/sdk @xandreed/plugin-agent-loop @xandreed/plugin-models @xandreed/plugin-tools-local
```

The remaining artifacts are local builds. The historical `efferent` npm
package is a different release line.

See [the framework guide](/docs/concepts/harness/), [source and contributing guide](https://github.com/xandreeddev/efferent).

MIT · Xand Reed
