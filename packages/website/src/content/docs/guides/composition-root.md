---
title: The composition root
description: Which Layers runAgent needs, what each provides, and which are optional — assembled once at the edge of your program.
sidebar:
  label: Composition root
  order: 2
---

`runAgent` is pure domain — it programs against [ports](/docs/concepts/architecture/). A driver
provides the concrete [adapter `Layer`s](/docs/reference/adapters/) once, at the edge, and hands off
to Bun. This is the whole "wire it up" step.

```ts
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import {
  LocalAuthStoreLive, LocalFileSystemLive, LocalSettingsStoreLive,
  ModelLive, ModelRegistryLive, StoresLive, UtilityLlmLive,
} from "@xandreed/sdk-adapters"

const AppLive = Layer.mergeAll(
  StoresLive,                 // ConversationStore (+ ContextTreeStore) — SQLite by default
  ModelLive,                  // the LanguageModel router
  UtilityLlmLive.pipe(        // optional: fast-tier helper calls
    Layer.provide(ModelRegistryLive),
    Layer.provide(FetchHttpClient.layer),
  ),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      LocalAuthStoreLive,     // creds from ~/.efferent/auth.json
      LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
    ),
  ),
  Layer.provideMerge(BunContext.layer), // platform FileSystem / Path
)

BunRuntime.runMain(program.pipe(Effect.provide(AppLive)))
```

## What each layer is for

| Layer | Required? | Provides |
| --- | --- | --- |
| `StoresLive` | ✅ | `ConversationStore` (+ `ContextTreeStore`) — SQLite by default. |
| `ModelLive` | ✅ | The `LanguageModel` router (needs `AuthStore` + `SettingsStore`). |
| `LocalAuthStoreLive` | ✅ | `AuthStore` — credentials from `~/.efferent/auth.json`. |
| `LocalSettingsStoreLive` | ✅ | `SettingsStore` — config from `~/.efferent/config.json`. |
| `LocalFileSystemLive` | ✅ | `FileSystem` — needed by settings/stores, and by any tool handler that reads files. |
| `BunContext.layer` | ✅ | Platform services (the SQLite store needs Bun's FileSystem/Path). |
| `UtilityLlmLive` | ⬜ optional | The [fast helper tier](/docs/concepts/providers/) — compaction digests, etc. Drop it and oversized clips degrade to plain markers. |
| `ModelRegistryLive`, `FetchHttpClient.layer` | ⬜ | Dependencies of `UtilityLlm`/the live catalogue. |
| `LocalShellLive`, `WebSearchLive` | ⬜ | Only if your tools use the `Shell` / `WebSearch` ports (the coding agent does). |

:::tip[The handler layer is separate]
The toolkit's **handler `Layer`** is provided *alongside* `AppLive`, not inside it —
`runAgent(...).pipe(Effect.provide(handlerLayer))` — because it carries the tool-specific runtime deps.
If a handler resolves a port (e.g. `FileSystem`), make sure that port is exposed by `AppLive` too. See the
[file agent](/docs/examples/file-agent/).
:::

## Swapping implementations

Because everything is a `Layer`, you change behaviour by changing an import: `EnvAuthStoreLive` instead of
`LocalAuthStoreLive` for CI; a Postgres store via `EFFERENT_DB_URL`; an in-memory store for tests;
`OtlpTelemetryLive` to turn on [tracing](/docs/concepts/observability/). The loop code never changes.
