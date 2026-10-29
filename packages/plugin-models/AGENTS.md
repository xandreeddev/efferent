# @xandreed/plugin-models

The models plugin: the routed `LanguageModel` (opencode, google, anthropic, openai and openai-codex, plus configured OpenAI-compatible endpoints), the fast `UtilityLlm`, the `ModelCatalog`, and the `AuthStore` and `SettingsStore` they read (`.efferent` files with `storage: "local"`, memory with `storage: "memory"`), with the Anthropic and OpenAI subscription sign-ins and one HTTP proxy transport for every call. Node 24.5 and Bun; layer `plugin-models` in `foundry.config.ts` (imports core, the `@effect/` provider packages, `undici`, `ws`, `node:` and `bun`; its tests, layer `plugin-models-tests`, add `fast-check`).

## Rules

- Build a provider per request from a freshly resolved key (`buildProvider`), never at layer build: a sign-in or a model switch applies on the next call.
- Send every outbound call (providers, compatible endpoints, OAuth refreshes, the subscription's WebSocket) through the `ModelsTransport` when one applies, as `transportFetchOf` does in `src/llm/router.ts`.
- Keep `storage: "memory"` off the disk; with `storage: "local"`, read and write files through `src/storage/json-file.ts`: only a missing file is empty, one it cannot use fails with `auth.corrupt` or `settings.corrupt` and is left as it was.
- Refresh a provider's token one at a time and commit it only if the provider still holds the credential refreshed, so a login or logout made meanwhile wins.
- Never repeat a secret in an error: an unknown option key is named without its value, and proxy URLs go through `redactCredentials`.
- Keep `CLAUDE_CODE_SYSTEM` byte-exact and first on Anthropic OAuth calls: the provider refuses the token otherwise.
- A route that reads no images (`imageInputFor`, an endpoint's `images`) is sent label lines (`promptWithImageLabels`), never the image and never a provider error.
- Decode an OpenAI-compatible body or stream chunk with `src/llm/chat-wire.entity.functions.ts` (`decodeChatCompletion`, `decodeStreamChunk`); one that does not decode fails as an `AiError`, and an empty 200 response is a transient failure (`rejectEmptyResponse`) unless the loop has set `CurrentEmptyResponseTolerance`.

## Public surface

- Plugin and models: `modelsPlugin` (also the default export; no `.live` alias), `LanguageModelLive`, `LanguageModelSelectionLive`, `generateWith`, `UtilityLlmLive`, `ConfiguredModelCatalogLive`, `configuredModelCatalog`, `imageInputFor`, `reasoningEffortsFor`; providers `buildProvider`, `chatCompletionsUrl`, `endpointOwnKey`, `prependClaudeCode`, `withAnthropicCacheBreakpoints`, `usesOpenCodeResponses`, `OPENCODE_CHAT_URL`, `OPENCODE_RESPONSES_API_URL`; retry `classifyLlmError`, `retryableLlm`, `rejectEmptyResponse`, `LLM_REQUEST_TIMEOUT_MS`, `MAX_HONORED_RETRY_AFTER_MS`.
- Wire clients and transport: `makeCompatLanguageModel`, `toChatMessages`, `toChatTools`, `fromChatCompletion`, `promptWithImageLabels` (also the `@xandreed/plugin-models/compat` subpath, `src/llm/compat.ts`); `makeOpenAiCodexLanguageModel`, `toOpenAiCodexRequestBody`, `OPENAI_CODEX_API_URL`, `makeOpenAiCodexSessions`, `makeOpenAiCodexWebSocketHttpClient`, `OpenAiCodexWebSocketHttpClient`, `normalizeOpenAiCodexWebSocketEvent`, `openAiCodexRefusal`, `openAiCodexUuidV7`, `OPENAI_CODEX_SESSION_CAPACITY`; the `ModelsTransport` port, `ModelsTransportLive`, `transportFetch`, `ModelEndpoint`, `ModelEndpoints`, `CurrentModelEndpoints`; proxy `ProxyConfig`, `ProxyEnvironment`, `ProxyUrlOption`, `HttpProxyOptions`, `NoProxyRule`, `ProxyInvalid`, `ProxyUnsupported`, `PROXY_VARIABLES`, `BUN_WEBSOCKET_PROXY_VERSION`, `NODE_WEBSOCKET_PROXY_VERSION`, `resolveProxy`, `proxyFor`, `parseNoProxy`, `bypassesProxy`, `isLoopback`, `redactCredentials`.
- Auth and settings: `LocalAuthStoreLive`, `authPaths`, `MemoryAuthStoreLive`, the `HostCredentials` port, `CredentialInput`, `CredentialInputs`, `credentialsOf`, `toCredential`, `toCredentialInput`, `RefreshableProvider`, `refreshCredential`, `isUsableAt`, `REFRESH_SKEW_MS`; OAuth `beginAnthropicOAuth`, `exchangeAnthropicCode`, `refreshAnthropicToken`, `generatePkce`, `parseAuthorizationInput`, `ANTHROPIC_OAUTH_BETA`, `CLAUDE_CODE_SYSTEM`, `beginOpenAiCodexOAuth`, `exchangeOpenAiCodexCode`, `refreshOpenAiCodexToken`, `openAiCodexAccountId`, `OPENAI_CODEX_CALLBACK_PATH`, `OPENAI_CODEX_CALLBACK_PORT`, `OPENAI_CODEX_CLIENT_ID`, `OPENAI_CODEX_REDIRECT_URI`; `LocalSettingsStoreLive`, `MemorySettingsStoreLive`, `RoleField`, `SettingValue`, `ROLE_FIELDS`, `applyRole`, `applySetting`, `coerceSettingValue`, `roleSelection`, `settingsFromRecord`, `roleModelView`.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `modelsPlugin` | `@xandreed/plugin-models` | runtime | `effect/ai/LanguageModel`, `@xandreed/core/UtilityLlm`, `@xandreed/core/AuthStore`, `@xandreed/core/SettingsStore`, `@xandreed/core/ModelCatalog` | none | `efferent/SessionEnvironment`; optional: `@xandreed/plugin-models/HostCredentials`, `@xandreed/plugin-models/ModelsTransport` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| Anthropic subscription system block `CLAUDE_CODE_SYSTEM` | `src/auth/anthropicOAuth.ts:28`, prepended by `prependClaudeCode` (`src/llm/providers.ts:81`, called at `src/llm/router.ts:128`) | unpinned |
| Codex default `instructions` (`You are a helpful assistant.`) when a request has no system text | `src/llm/openAiCodex.ts:58` | exact, `src/llm/providers.test.ts:60`, `src/llm/openAiCodex.test.ts:40` |
| Label lines in place of unsent files: the message's text, then one line per file part | `src/llm/compat.ts:147-158`, `:268-286` | exact, `src/llm/compat.test.ts:434`, `:500`, `:504`; `src/llm/providers.test.ts:209` |
| Non-image file label (`[file omitted: <type>, <name>]`); images use core's `mediaLabel` | `src/llm/compat.ts:123` | unpinned |
| Image captions: `Images returned by <tool> (call <id>):`, `[the images this call returned follow]`, `The user's message:` | `src/llm/compat.ts:224`, `:229`, `:178` | exact, `src/llm/compat.test.ts:462` (first two), `:492` (the third); `src/llm/providers.test.ts:209` |

## Erasure files

- `src/llm/router.ts`, `src/llm/providers.ts`: one routed `LanguageModel` over arbitrary provider services, with reshaped options and the generic `generateText`/`generateObject`/`streamText` signatures (for example `router.ts:259`, `:585-589`); `withImageLabels` re-wraps those three methods (`providers.ts:56-58`) and a cache-control message is rebuilt with `Prompt.makeMessage` (`providers.ts:122`).
- `src/llm/compat.ts`, `src/llm/openAiCodex.ts`: effect/ai's generic `LanguageModel` surface over hand-built clients (`compat.ts:511`, `:530`; `openAiCodex.ts:207-218`), and `Tool.Any`'s description and schema (`compat.ts:298-299`).
- `src/transport/undici-fetch.adapter.ts`: npm undici's fetch typed as the global one; its classes differ, so nothing downstream may rely on `instanceof Response` or `Headers`.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | the plugin: options, memory or local stores, the transport beneath them |
| `src/llm/` | `router.ts` (routed and selection models), `providers.ts`, `compat.ts` with `chat-wire.entity*.ts` and `sse.ts` (OpenAI-compatible client), `openAiCodex.ts` and `openAiCodexWebSocket.ts` (subscription), `retry.ts`, `modelCatalog.ts`, `utilityLlm.ts` |
| `src/auth/`, `src/settings/` | `localAuth.ts`, `memory-auth.adapter.ts`, `anthropicOAuth.ts`, `openAiCodexOAuth.ts`, the `credential-input`, `credential-refresh` and `token-response` entity pairs; `localSettings.ts`, `memory-settings.adapter.ts`, the `settings-value` entity pair, `roleView.ts` |
| `src/transport/` | the `http-proxy` entity pair (proxy and `NO_PROXY` rules), `models-transport.adapter.ts`, `undici-fetch.adapter.ts` |
| `src/ports/`, `src/storage/json-file.ts` | `HostCredentials`, `ModelsTransport`, `ModelEndpoints`; atomic JSON files under a per-file lock |
| `src/testing.ts`, `src/transport/recording-proxy.testing.ts` | test support, left out of the build: `damagedFile`, `tokenEndpoint`, a recording proxy |

## Tests

- Kits: `authStoreConformance` on both auth stores (`src/auth/memory-auth.adapter.test.ts`), `settingsStoreConformance` on both settings stores (`src/settings/memory-settings.adapter.test.ts`), `modelCatalogConformance` (`src/llm/modelCatalog.test.ts`), and all three on the plugin's own stores (`src/plugin.adapter.test.ts:205`, `:219`).
- `packages/sdk/src/models-plugin.test.ts` drives the plugin under `Agent.define`; the sdk golden uses a scripted model, so none of the text above is in it. `verify:packages` runs `scripts/models-consumer.fixture.mjs` and `scripts/proxy-consumer.fixture.mjs` on Node over the packed package; CI reruns `src/llm/openAiCodexWebSocket.test.ts`, `src/plugin.adapter.test.ts` and `src/transport/models-transport.adapter.test.ts` on Bun 1.3.6.
- Run: `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/plugin-models packages/sdk/src/models-plugin.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
