---
name: adapters
description: Owns packages/adapters/. Concrete implementations of @agent/core ports — IO and provider SDKs live here and nowhere else.
---

## Layout
One subfolder per concern: `src/llm/` (the multi-provider router + clients + catalogue), `src/conversationStore/` (`ConversationStore`), `src/database/` (Postgres), `src/fileSystem/`, `src/shell/`, `src/http/`, `src/settings/`. Each adapter exports a `Layer` named `<Thing>Live`; `src/index.ts` re-exports them.

Key Layers: `ModelLive` (bundles the router `LanguageModel` + `ModelRegistry` + dynamic `LlmInfo`, requires only `SettingsStore`), `RouterLanguageModelLive`, `ModelRegistryLive`, `GoogleClientLive`/`OpenAiClientLive`/`ProviderClientsLive`, `LlmInfoLive`, `LocalFileSystemLive`, `LocalShellLive`, `HttpLive`, `LocalSettingsStoreLive`, `DatabaseLive`, `PostgresConversationStoreLive`.

## Hard rules
- Each adapter is a `Layer.effect(Port, Effect.gen(function* () { ... return { method: ... } }))`.
- All external promises go through `Effect.tryPromise`, with the `catch` mapping the thrown value into the port's tagged error type. Never let an untyped error escape.
- Read configuration via `Config.string` / `Config.redacted` / `Config.number`, not `process.env`. Provider API keys are **key-optional** (`Config.option`) so a missing `OPENAI_API_KEY` never blocks a Google-only user — an absent key only 401s if that provider is actually selected.
- Adapters may depend on `@agent/core` + `@effect/ai` provider packages (`@effect/ai-google`, `@effect/ai-openai`) and other SDKs only. Never import from `@agent/cli`/`@agent/web`/other adapters.

## Multi-provider router (src/llm/)
- The agent loop talks to one provider-agnostic `LanguageModel`; provider/model is a **runtime selection**, not a compile-time layer. `RouterLanguageModelLive` reads `ModelRegistry.current` on every call and delegates to the chosen provider's `@effect/ai` service, built on the fly from the captured `GoogleClient`/`OpenAiClient`.
- Selection lives in `SettingsStore` as `settings.model = "<provider>:<modelId>"` (persisted to `.agent/config.json`). `parseModel`/`formatModel`/`contextWindowFor` are pure helpers in `@agent/core` `Model.ts`.
- `ModelRegistryLive` fetches the live catalogue over **raw HTTP** (Google `…/v1beta/models`, OpenAI `…/v1/models`) and parses defensively — the generated `@effect/ai-*` list schemas are stricter than the live APIs and fail to decode. Only providers whose key is set are queried.
- Caching is provider-native: OpenAI automatic prefix caching + stable `prompt_cache_key`; Gemini implicit context caching (stable prefix → `cachedContentTokenCount`). Explicit Gemini `cachedContent` isn't expressible through `@effect/ai-google` today.
