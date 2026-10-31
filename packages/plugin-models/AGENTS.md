# @xandreed/plugin-models

The models plugin: the routed `LanguageModel` (opencode, google, anthropic, openai and openai-codex, plus configured chat-completions and Anthropic Messages endpoints), the fast `UtilityLlm`, the `ModelCatalog`, and the `AuthStore` and `SettingsStore` they read (`.efferent` files with `storage: "local"`, memory with `storage: "memory"`), with the Anthropic and OpenAI subscription sign-ins and one HTTP proxy transport for every call. Node 24.5 and Bun; layer `plugin-models` in `foundry.config.ts` (imports core, `effect/ai`, `effect/http`, `effect/socket`, the provider packages `@effect/ai-anthropic` and `@effect/ai-openai`, which no other package may import, `undici`, `ws` and `node:`; it tells Bun by `process.versions` and reaches its `fetch` and `WebSocket` as globals, importing no `bun` module; its tests, layer `plugin-models-tests`, add `bun:test`, `fast-check` and `effect/testing`).

## Rules

- Build a provider per request from a freshly resolved key (`buildProvider`), never at layer build: a sign-in or a model switch applies on the next call.
- Name a built-in provider only in its profile (`PROVIDER_PROFILES`, `src/llm/provider-profile.entity.functions.ts`): its catalog, each model's images and efforts, and the route a model is sent over. The catalog, `imageInputFor`, `reasoningEffortsFor` and `buildProvider` read the table; a builder serves a route, never a provider name.
- Send every outbound call (providers, compatible endpoints, OAuth refreshes, the subscription's WebSocket) through the `ModelsTransport` when one applies, as `throughTransport` does in `src/llm/router.ts`.
- Read what a routed call is built over (`CurrentModelEndpoints`, `CurrentModelSettings`, `ModelsTransport`, a subscription session cache of the layer's own: `layerProviderServices`) once, where the router's layer is built, and pass it to each call as an argument (`ProviderServices`). Replay no captured context on a call but the layer's stores (`Context.pick(AuthStore, SettingsStore)`): the references a call carries (its call policy, prompt cache key, trace content, log annotations) are the call's own.
- Keep `storage: "memory"` off the disk; with `storage: "local"`, read and write files through `src/storage/json-file.ts`: only a missing file is empty, one it cannot use fails with `auth.corrupt` or `settings.corrupt` and is left as it was.
- Never change the stores' service keys. `AuthStore` and `SettingsStore` (`src/ports/auth-store.port.ts`, `src/ports/settings-store.port.ts`) are this package's ports, but they keep the keys core declared them with, `@xandreed/core/AuthStore` and `@xandreed/core/SettingsStore`: plugins' `provides` and `requires`, hosts' bindings and the plugin reference name them.
- Keep reading what older releases wrote: `auth.json` and the settings files keep their formats, and a settings file that still holds the `sandbox` or `viMode` key decodes with the key unread (`EngineSettings` names neither, and a store keeps it when it writes another).
- Refresh a provider's token one at a time and commit it only if the provider still holds the credential refreshed, so a login or logout made meanwhile wins.
- Never repeat a secret in an error: an unknown option key is named without its value, proxy URLs go through `redactCredentials`, and a token endpoint's refusal quotes its body only through `tokenRefusalText`, which replaces every secret the request sent first.
- Keep credential secrets `Redacted` (`Credential` decodes them so, and `TokenResponse` decodes a token endpoint's answer so): unwrap one with `Redacted.value` only where a request is built, and compare two with `Equal.equals` (`isSameToken`), never `===`. Write a credential only in its encoded form (`encodeCredential`, which `writeAuthFile` applies to every entry it writes), never through `JSON.stringify`, which writes `"<redacted>"` and so erases the secret; the round-trip test in `src/auth/localAuth.test.ts` guards it.
- Keep `CLAUDE_CODE_SYSTEM` byte-exact and first on Anthropic OAuth calls: the provider refuses the token otherwise.
- Add an Anthropic beta to a request's `anthropic-beta` header (`withAnthropicBetas`, `mergeBetas`), never set the header: the client's own betas (structured outputs, documents, the subscription's) must stay.
- Send the thinking binding (`thinkingPrefixMismatch`, `CurrentThinkingPrefixMismatch`; default drop_block) only to a model whose profile `bindsThinking` with effective Adaptive thinking, with its beta; keep its untyped request fields in `providers.ts`, and never let reading `input_transformations` fail or change a response.
- A route that reads no images (`imageInputFor`, an endpoint's `images`) is sent label lines (`promptWithImageLabels`), never the image and never a provider error.
- Bound a routed call by one `CallBudget`, shared by its attempts and a settled call's fallback rung, and make the call final once it hands a tool call to its toolkit (`withHandOff` in `src/llm/router.ts`): after that no retry, no fallback and no router bound, since the tools would run again. Bound an attempt by racing it (`retryableLlm`), never by wrapping it in a timeout, which would count the tools' time. A stream's idle bound (`retryableLlmStream`) leaves out the time its tool handlers run (the budget's `inFlight`, which `withHandOff` counts), and its retries stop at its first content part.
- Decode an OpenAI-compatible body or stream chunk with `src/llm/chat-wire.entity.functions.ts` (`decodeChatCompletion`, `decodeStreamChunk`); one that does not decode fails as an `AiError`, and an empty 200 response is a transient failure (`rejectEmptyResponse`) unless the loop has set `CurrentEmptyResponseTolerance`.

- `modelSettings` is a static full-selection map captured once alongside endpoints. Per-request caps/effort precede settings and documented profiles; unknown Messages IDs require an explicit cap. Keep stored ModelCallPolicy decoding unchanged and validate effective values at the provider edge.
- The shared Messages builder separates API/gateway authentication from subscription OAuth. Preserve opaque keys, explicit empty keys, version headers and the merged beta header; a configured bearer key never implies subscription instructions.
- Model-specific thinking and forced-tool validity comes from profile traits. Keep wire erasure only in providers.ts, and test settled, streaming and object paths before changing compatibility logic. Config failures are InvalidRequest, separate from authentication.

- Plan cache slots over the actual prepared SDK payload through the captured client's settled and streaming methods. Candidates are identified by immutable per-call object references from `CurrentPromptCacheFrame`, never a shared mutable set or serialized sentinel. Count fanout per location, preserve caller controls and lifetime order, and keep tools/system/messages/nested content in semantic order.
- Per-model `promptCache` defaults to Auto5m. Auto uses only the stable prefix; TopLevel deliberately follows the provider's last-block semantics. A Messages endpoint's `cacheControl: false` removes legitimate null fields and refuses caller markers; never walk business input or tool schemas as cache metadata. Strip recognized volatile engine bookkeeping before every protocol serializer.

## Public surface

- Plugin and models: `modelsPlugin` (also the default export; no `.live` alias), `LanguageModelLive`, `LanguageModelSelectionLive`, `UtilityLlmLive`, `ConfiguredModelCatalogLive`, `roleModelView`, `imageInputFor`, `reasoningEffortsFor` (`ReasoningEffort`); the configured endpoints `ModelEndpoint`, `ModelEndpoints`, `CurrentModelEndpoints`, plus `ModelThinking`, `ModelSettings`, `ModelSettingsMap`, `ModelSettingsError`, `PromptCacheSettings` and `CurrentModelSettings`; a call's bounds `LLM_REQUEST_TIMEOUT_MS` and `LLM_CALL_BUDGET_MS`.
- Transport: the `ModelsTransport` port (`ModelsFetch`, `WebSocketProxy`), `ModelsTransportLive` with its options (`HttpProxyOptions`, `ProxyUrlOption`) and errors (`ProxyInvalid`, `ProxyUnsupported`); `makeOpenAiCodexWebSocketHttpClient`, the subscription's WebSocket client over a transport.
- Auth: the `AuthStore` port (`Credential`, `AuthError`), `LocalAuthStoreLive`, `MemoryAuthStoreLive` (`MemoryAuthOptions`) and the `HostCredentials` port (`CredentialInput`, `CredentialInputs`, `AccountId`, `InstallationId`); for a store of the host's own, the refresh its `resolveKey` owes: `refreshCredential`, `isUsableAt`, `REFRESH_SKEW_MS`, `RefreshableProvider`, `OAuthCredential`. The subscription sign-ins: `beginAnthropicOAuth` (`OAuthBegin`), `parseAuthorizationInput` (`AuthRedirect`), `exchangeAnthropicCode` and `refreshAnthropicToken` (`RefreshedTokens`), `beginOpenAiCodexOAuth` (`OpenAiCodexOAuthBegin`), `exchangeOpenAiCodexCode` and `refreshOpenAiCodexToken` (`OpenAiCodexTokens`), each request taking `TokenRequestOptions`.
- Settings: the `SettingsStore` port (`EngineSettings`, `SettingsError`, `ModelRole`, `SETTINGS_KEYS`, `SettingsKey`), `LocalSettingsStoreLive`, `MemorySettingsStoreLive`; for a store of the host's own, the checks the port's writes make: `applyRole`, `applySetting`, `coerceSettingValue`, `roleSelection`, `settingsFromRecord`, `ROLE_FIELDS` (`RoleField`, `SettingValue`).
- The OpenAI-compatible client, the `@xandreed/plugin-models/compat` subpath (`src/compat/index.ts`) and not the root: `makeCompatLanguageModel` (`CompatConfig`), `toChatMessages` (`ChatMessageOptions`), `promptWithImageLabels`.
- Kits, the `@xandreed/plugin-models/conformance` subpath (`src/conformance/index.ts`) and not the root: `authStoreConformance` (`AuthStoreConformanceOptions`, `AuthStoreRefreshProbe`) and `settingsStoreConformance` (`SettingsStoreConformanceOptions`), each tagged `@public` (`quality/exports-have-consumers` runs on the entry). They are built with core's `check` and `ConformanceFailure` (`@xandreed/core/conformance`) and `randomUuid` (`@xandreed/core/internal`).

The three entries name each export, and `quality/exports-have-consumers` checks each one: the docs, the scripts (the plugin reference, the packed consumers, `verify:packages`) and the sdk's tests import some, and the rest, which no first-party code imports, are tagged `@public` at their declarations (`modelsPlugin`'s tag covers the default export). How the plugin routes and sends a call stays inside the package: the provider builders (`buildProvider`), retries and budgets (`retryableLlm`, `makeCallBudget`), the subscription's wire (`makeOpenAiCodexLanguageModel`), the proxy's resolution (`resolveProxy`, `proxyFor`) and the OAuth protocol's constants.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `modelsPlugin` | `@xandreed/plugin-models` | runtime | `effect/ai/LanguageModel`, `@xandreed/core/UtilityLlm`, `@xandreed/core/AuthStore`, `@xandreed/core/SettingsStore`, `@xandreed/core/ModelCatalog` | none | `efferent/SessionEnvironment`; optional: `@xandreed/plugin-models/HostCredentials`, `@xandreed/plugin-models/ModelsTransport` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| Anthropic subscription system block `CLAUDE_CODE_SYSTEM` | `src/auth/anthropicOAuth.ts:28`, prepended by `prependClaudeCode` (`src/llm/providers.ts:172`, called at `src/llm/router.ts:147`) | exact, `src/llm/providers.test.ts:290` |
| Codex default `instructions` (`You are a helpful assistant.`) when a request has no system text | `src/llm/openAiCodex.ts:59` | exact, `src/llm/providers.test.ts:61`, `src/llm/openAiCodex.test.ts:40` |
| Label lines in place of unsent files: the message's text, then one line per file part | `src/llm/compat.ts:148-159`, `:274-290` | exact, `src/llm/compat.test.ts:441`, `:447`, `:457`, `:530`, `:534`; `src/llm/providers.test.ts:224` |
| File label (`[file omitted: <type>, <name>]`, the name when the part has one) for any file part but an inline image, an image by URL included; an inline image uses core's `mediaLabel` | `src/llm/compat.ts:126` | exact, `src/llm/compat.test.ts:457` |
| Image captions: `Images returned by <tool> (call <id>):`, `[the images this call returned follow]`, `The user's message:` | `src/llm/compat.ts:229`, `:234`, `:183` | exact, `src/llm/compat.test.ts:492` (first two), `:522` (the third); `src/llm/providers.test.ts:224` |

## Erasure files

- `src/llm/router.ts`, `src/llm/providers.ts`: one routed `LanguageModel` over arbitrary provider services, with reshaped options and the generic `generateText`/`generateObject`/`streamText` signatures (for example `router.ts:350`, `:683-687`); `withImageLabels` re-wraps those three methods (`providers.ts:70-72`) and a cache-control message is rebuilt with `Prompt.makeMessage` (`providers.ts:124`).
- `src/llm/compat.ts`, `src/llm/openAiCodex.ts`: effect/ai's generic `LanguageModel` surface over hand-built clients (`compat.ts:517`, `:536`; `openAiCodex.ts:208-219`), and `Tool.Any`'s description and schema (`compat.ts:303-304`).
- `src/transport/undici-fetch.adapter.ts`: npm undici's fetch typed as the global one; its classes differ, so nothing downstream may rely on `instanceof Response` or `Headers`.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | the plugin: options, memory or local stores, the transport beneath them |
| `src/llm/` | `router.ts` (routed and selection models), `providers.ts` (one builder per route), the `provider-profile` and `model-settings` entity pairs (static traits and per-model controls), `compat.ts` with `chat-wire.entity*.ts` and `sse.ts` (OpenAI-compatible client), `openAiCodex.ts` and `openAiCodexWebSocket.ts` (subscription), `retry.ts`, `modelCatalog.ts`, `utilityLlm.ts` |
| `src/auth/`, `src/settings/` | `localAuth.ts`, `memory-auth.adapter.ts`, `anthropicOAuth.ts`, `openAiCodexOAuth.ts`, the `credential-input`, `credential-refresh` and `token-response` entity pairs, the `AuthStore` kit (`auth-store.conformance.ts`); `localSettings.ts`, `memory-settings.adapter.ts`, the `settings-value` entity pair, `roleView.ts`, the `SettingsStore` kit (`settings-store.conformance.ts`) |
| `src/compat/index.ts` | the `./compat` entry: the OpenAI-compatible client |
| `src/conformance/index.ts` | the `./conformance` entry: the two kits |
| `src/transport/` | the `http-proxy` entity pair (proxy and `NO_PROXY` rules), `models-transport.adapter.ts`, `undici-fetch.adapter.ts` |
| `src/ports/`, `src/storage/json-file.ts` | `AuthStore` (with `Credential`, `AuthError`), `SettingsStore` (with `EngineSettings`, `SettingsError`), `HostCredentials`, `ModelsTransport`, `ModelEndpoints` and `CurrentModelSettings`; atomic JSON files under a per-file lock |
| `src/testing.ts`, `src/transport/recording-proxy.testing.ts` | test support, left out of the build: `damagedFile`, `tokenEndpoint`, a recording proxy |

## Tests

- Kits: `authStoreConformance` on both auth stores (`src/auth/memory-auth.adapter.test.ts`), `settingsStoreConformance` on both settings stores (`src/settings/memory-settings.adapter.test.ts`), core's `modelCatalogConformance` (`src/llm/modelCatalog.test.ts`), and all three on the plugin's own stores (`src/plugin.adapter.test.ts:205`, `:219`). The two kits' self-tests, reference stores that pass and careless ones that must fail, are `src/auth/auth-store.conformance.test.ts` and `src/settings/settings-store.conformance.test.ts`.
- `packages/sdk/src/models-plugin.test.ts` drives the plugin under `Agent.define`; the sdk golden uses a scripted model, so none of the text above is in it. `verify:packages` runs `scripts/models-consumer.fixture.mjs` and `scripts/proxy-consumer.fixture.mjs` on Node over the packed package, plus the shared `scripts/anthropic-messages-consumer.fixture.mjs` on Node and Bun; CI reruns `src/llm/openAiCodexWebSocket.test.ts`, `src/plugin.adapter.test.ts` and `src/transport/models-transport.adapter.test.ts` on Bun 1.3.6.
- Run: `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/plugin-models packages/sdk/src/models-plugin.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
