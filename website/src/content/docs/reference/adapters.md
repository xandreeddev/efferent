---
title: Adapter layers
description: The *Live layers from @xandreed/sdk-adapters — what each provides and what it needs.
sidebar:
  label: Adapter layers
  order: 6
---

Each adapter is a `Layer` named `<Thing>Live` providing exactly one [port](/efferent/reference/ports/)
(or a bundle). You compose the ones you need at the [composition root](/efferent/guides/composition-root/).

| Layer | Provides | Needs / notes |
| --- | --- | --- |
| `StoresLive` | `ConversationStore` + `ContextTreeStore` | SQLite by default; Postgres via `EFFERENT_DB_URL`. Needs platform FS/Path (`BunContext`). |
| `ModelLive` | `LanguageModel` (router) + `LlmInfo` | Needs `AuthStore` + `SettingsStore`. Resolves provider/key **per request**. |
| `ModelRegistryLive` | `ModelRegistry` | Live catalogue over HTTP for logged-in providers. |
| `UtilityLlmLive` | `UtilityLlm` | The fast helper tier. Needs `ModelRegistry` + an HTTP client. Optional. |
| `WebSearchLive` | `WebSearch` | Provider server-side grounding (Gemini / OpenAI). |
| `LocalAuthStoreLive` | `AuthStore` | `~/.efferent/auth.json`, atomic `0600`, OAuth refresh. |
| `EnvAuthStoreLive` | `AuthStore` | **CI/evals only** — the one place provider key env vars are read. |
| `AuthFlowLive` | `AuthFlow` | OAuth PKCE + token exchange. |
| `LocalSettingsStoreLive` | `SettingsStore` | Global + local `config.json` tiers. Needs `FileSystem`. |
| `LocalFileSystemLive` | `FileSystem` | `node:fs` + gitignore-aware glob. `Layer.succeed` (no deps). |
| `LocalShellLive` | `Shell` | Bun `spawn`, streaming. |
| `HttpLive` | `Http` | global `fetch`, body capped at `maxBytes`. |
| `OtlpTelemetryLive` | (tracer/meter at the edge) | OTLP export over HTTP; gated by `Settings.telemetry`. See [observability](/efferent/concepts/observability/). |

Rules that hold across all adapters: external promises go through `Effect.tryPromise` mapped into the
port's tagged error (no untyped error escapes), and **keys are never captured at layer-build** — they're
resolved from `AuthStore` per call, so `:login` / `:model` apply on the next request with no rebuild.
