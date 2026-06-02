import { LanguageModel, Prompt } from "@effect/ai"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { AuthStore, LlmInfo, ModelRegistry, type ModelSelection } from "@efferent/core"
import { Effect, Layer, Redacted, type Scope, Stream } from "effect"
import {
  ANTHROPIC_OAUTH_BETA,
  CLAUDE_CODE_SYSTEM,
} from "../auth/oauth/anthropic.js"
import { ModelRegistryLive } from "./modelRegistry.js"

// Anthropic OAuth: authenticate as a subscription (Bearer + Claude Code beta
// flags), never `x-api-key`.
const oauthTransform =
  (access: Redacted.Redacted) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequest((req) =>
        req.pipe(
          HttpClientRequest.setHeaders({
            Authorization: `Bearer ${Redacted.value(access)}`,
            "anthropic-beta": ANTHROPIC_OAUTH_BETA,
          }),
        ),
      ),
    )

// The required first system block for OAuth tokens (prepended for that path).
const claudeCodePrompt = Prompt.make([
  { role: "system", content: CLAUDE_CODE_SYSTEM },
])
const prependClaudeCode = (options: unknown): unknown => ({
  ...(options as Record<string, unknown>),
  prompt: Prompt.merge(
    claudeCodePrompt,
    Prompt.make((options as { prompt: Prompt.RawInput }).prompt),
  ),
})

/**
 * The single `LanguageModel` the agent loop talks to. It is provider-
 * agnostic: on every call it reads `ModelRegistry.current`, resolves a usable
 * key from the `AuthStore` (refreshing an expired OAuth token first), and
 * builds the chosen provider's `@effect/ai` service from that key — all per
 * request. So a credential added mid-session via `:login`, or a `/model`
 * provider switch, takes effect on the **next turn with no rebuild/restart**:
 * the key is read fresh and the thin provider client (over a shared
 * `FetchHttpClient`) is rebuilt for the call's duration.
 *
 * Caching is aggressive but provider-native:
 *   - **OpenAI**: automatic prompt-prefix caching; we set a stable
 *     `prompt_cache_key` so repeated prefixes route to the same cache.
 *   - **Gemini**: implicit context caching kicks in automatically for a
 *     stable prefix (visible via `cachedContentTokenCount`); explicit
 *     `cachedContent` resources aren't expressible through `@effect/ai-google`
 *     today (it always sends the full `contents`), so we rely on implicit.
 */
export const RouterLanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    const authStore = yield* AuthStore
    const http = yield* HttpClient.HttpClient

    // Build the provider's LanguageModel for this selection from a freshly
    // resolved key. The provider client is created as a *scoped value* (not a
    // layer that closes early), so it stays alive for the whole call when the
    // caller wraps it in `Effect.scoped` / `Stream.unwrapScoped`. A missing
    // key yields a client that 401s only when used (the no-credential case is
    // headed off by the TUI send-gate + boot warning).
    const buildSvc = (
      sel: ModelSelection,
      key: Redacted.Redacted | undefined,
      oauth: boolean,
    ): Effect.Effect<
      LanguageModel.Service,
      never,
      HttpClient.HttpClient | Scope.Scope
    > => {
      switch (sel.provider) {
        case "google":
          return GoogleClient.make({ apiKey: key }).pipe(
            Effect.flatMap((client) =>
              GoogleLanguageModel.make({ model: sel.modelId }).pipe(
                Effect.provideService(GoogleClient.GoogleClient, client),
              ),
            ),
          )
        case "anthropic":
          return (
            oauth && key !== undefined
              ? AnthropicClient.make({
                  apiKey: undefined,
                  transformClient: oauthTransform(key),
                })
              : AnthropicClient.make({ apiKey: key })
          ).pipe(
            Effect.flatMap((client) =>
              AnthropicLanguageModel.make({ model: sel.modelId }).pipe(
                Effect.provideService(AnthropicClient.AnthropicClient, client),
              ),
            ),
          )
        default:
          return OpenAiClient.make({ apiKey: key }).pipe(
            Effect.flatMap((client) =>
              OpenAiLanguageModel.make({
                model: sel.modelId,
                config: { prompt_cache_key: "efferent" },
              }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client)),
            ),
          )
      }
    }

    // Resolve the current selection + credential, then build the service. A
    // refresh failure (AuthError) degrades to "no key" rather than a typed
    // error, so the LanguageModel error channel stays the AI error the loop
    // expects. `oauth` flags the subscription path (Bearer + system spoof).
    const resolveAndBuild = (sel: ModelSelection) =>
      Effect.gen(function* () {
        const cred = yield* authStore.get(sel.provider)
        const key = yield* authStore
          .resolveKey(sel.provider)
          .pipe(Effect.orElseSucceed(() => undefined))
        const oauth = cred?.type === "oauth"
        const svc = yield* buildSvc(sel, key, oauth)
        return { svc, oauth }
      })

    const service: LanguageModel.Service = {
      generateText: (options) =>
        registry.current.pipe(
          Effect.flatMap((sel) =>
            resolveAndBuild(sel).pipe(
              Effect.flatMap(({ svc, oauth }) =>
                svc.generateText(
                  oauth ? (prependClaudeCode(options) as typeof options) : options,
                ),
              ),
            ),
          ),
          Effect.scoped,
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      generateObject: (options) =>
        registry.current.pipe(
          Effect.flatMap((sel) =>
            resolveAndBuild(sel).pipe(
              Effect.flatMap(({ svc, oauth }) =>
                svc.generateObject(
                  oauth ? (prependClaudeCode(options) as typeof options) : options,
                ),
              ),
            ),
          ),
          Effect.scoped,
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      streamText: (options) =>
        Stream.unwrapScoped(
          registry.current.pipe(
            Effect.flatMap((sel) =>
              resolveAndBuild(sel).pipe(
                Effect.map(({ svc, oauth }) =>
                  svc.streamText(
                    oauth ? (prependClaudeCode(options) as typeof options) : options,
                  ),
                ),
              ),
            ),
            Effect.provideService(HttpClient.HttpClient, http),
          ),
        ),
    }
    return service
  }),
)

/** Status-bar metadata follows the live selection (model id + window). */
export const LlmInfoLive = Layer.effect(
  LlmInfo,
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    return {
      metadata: registry.current.pipe(
        Effect.map((sel) => ({
          modelId: sel.modelId,
          contextWindow: sel.contextWindow,
        })),
      ),
    }
  }),
)

/**
 * The complete model tier: the router `LanguageModel`, the live
 * `ModelRegistry`, and the dynamic `LlmInfo`. A shared `FetchHttpClient` is
 * provided internally; the tier requires `SettingsStore` (the selection's
 * source of truth) and `AuthStore` (credentials) from the composition root.
 */
export const ModelLive = Layer.mergeAll(RouterLanguageModelLive, LlmInfoLive)
  .pipe(Layer.provideMerge(ModelRegistryLive))
  .pipe(Layer.provide(FetchHttpClient.layer))

/**
 * The platform `HttpClient` layer, re-exported so driver packages that don't
 * depend on `@effect/platform` directly (e.g. evals) can satisfy
 * `WebSearchLive`'s HTTP requirement.
 */
export const FetchHttpClientLive = FetchHttpClient.layer
