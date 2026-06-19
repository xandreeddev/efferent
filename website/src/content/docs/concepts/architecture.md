---
title: Architecture — ports & adapters on Effect
description: How efferent is layered — a pure domain of ports and use cases, concrete adapters, and thin drivers — with dependencies pointing strictly inward.
sidebar:
  label: Architecture
  order: 1
---

efferent is a ports-and-adapters (hexagonal) design expressed in [Effect](https://effect.website).
Three layers, with dependencies pointing **strictly inward**:

```
packages/
├── sdk-core/      pure domain: entities, ports, use cases, prompts   (depends on effect + @effect/ai)
├── sdk-adapters/  Layer impls of the ports                           (depends on sdk-core + external SDKs)
└── code/          a driver: the coding agent's TUI / print / json / rpc modes
```

`code → sdk-adapters → sdk-core`. The core imports nothing from its siblings; adapters import the core
plus the one external SDK they wrap; drivers compose the `Layer`s at the very edge and hand off to
`BunRuntime.runMain`. Your own agent is just another driver.

## Ports are services

A **port** is a `Context.Tag` service in `@xandreed/sdk-core` describing a capability the domain needs
from the outside world — a file system, a shell, a conversation store, an LLM. Each port ships its
tagged errors next to it. The use cases program against the *tag*, never a concrete implementation:

```ts
import { FileSystem } from "@xandreed/sdk-core"

const readConfig = Effect.gen(function* () {
  const fs = yield* FileSystem          // the port, by tag
  return yield* fs.read("efferent.json") // returns a typed Effect<…, FileError, …>
})
```

The full set: `ConversationStore`, `ContextTreeStore`, `FileSystem`, `Shell`, `Http`, `WebSearch`,
`AuthStore`, `SettingsStore`, `ModelRegistry`, `LlmInfo`, `UtilityLlm`, `Approval`, `AuthFlow`. See the
[ports reference](/efferent/reference/ports/).

## Adapters are Layers

An **adapter** in `@xandreed/sdk-adapters` provides exactly one port as a `Layer` named `<Thing>Live`.
External promises go through `Effect.tryPromise`, mapped into the port's tagged error — an untyped error
never escapes. Keys and config are resolved *per call* (never captured at layer-build), so a `:login` or
`/model` switch applies on the next request with no rebuild. See the
[adapters reference](/efferent/reference/adapters/).

## Use cases are Effects

The domain logic — the [agent loop](/efferent/concepts/agent-loop/), [handoff](/efferent/concepts/headroom/),
[sub-agent spawning](/efferent/concepts/sub-agents/) — lives in `usecases/` as Effects over the ports. No
IO; the only SDK allowed in the core is `@effect/ai` (provider-agnostic: `LanguageModel`, `Tool`,
`Toolkit`, `Prompt`). Provider packages live in adapters.

:::note
**No `try` / `catch` / `throw` in the core.** Error handling is Effect's typed errors
(`Effect.fail`, `Effect.catchTag`, …), enforced by an AST scan in the typecheck gate. Errors are part of
each function's type, so the compiler tells you what can go wrong.
:::

## Composition happens at the edge

A driver assembles the layers once and provides them to `runAgent`. Because everything is a `Layer`, you
swap an implementation by swapping an import — Postgres for SQLite, a stub LLM for a real one in tests,
an in-memory store for evals. That single seam is what makes the agent loop the same code in the TUI, in
a one-shot script, in CI, and in your app. See [the composition root](/efferent/guides/composition-root/).
