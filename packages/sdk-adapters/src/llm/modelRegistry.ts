import {
  AuthStore,
  catalogModelIdsForProvider,
  catalogModelsForProvider,
  contextWindowFor,
  formatModel,
  ModelRegistry,
  parseModel,
  SettingsStore,
  type Credential,
  type ModelInfo,
  type Provider,
} from "@xandreed/sdk-core"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"

/**
 * Runtime model selection + live catalogue. The selection lives in
 * `SettingsStore` (persisted as `"<provider>:<modelId>"`, the single source
 * of truth the router reads each turn). The catalogue is fetched live over
 * raw HTTP and parsed defensively — the `@effect/ai-*` generated list
 * schemas are stricter than the real APIs (e.g. Google's `ListModels` omits
 * `baseModelId`), so decoding through the SDK clients fails; reading the
 * handful of fields we need by hand keeps the list live and drift-proof.
 *
 * Keys come from the `AuthStore` (`~/.efferent/auth.json`), resolved per call
 * — a provider with no credential simply contributes nothing to the list.
 */

// Google: keep chat/tool-capable models; drop embeddings / image / tts / aqa.
const GOOGLE_EXCLUDE = /embedding|aqa|imagen|veo|tts|image/i
// OpenAI exposes no capability flag, so gate by id shape.
const OPENAI_INCLUDE = /^(gpt-|o1|o3|o4|chatgpt)/i
const OPENAI_EXCLUDE =
  /embedding|whisper|tts|audio|realtime|image|dall-e|moderation|transcribe|search|babbage|davinci|instruct|codex/i

import { OLLAMA_DEFAULT_BASE_URL } from "./ollama.js"

type GoogleModel = {
  readonly name?: string
  readonly displayName?: string
  readonly supportedGenerationMethods?: ReadonlyArray<string>
  readonly inputTokenLimit?: number
}
type OpenAiModel = { readonly id?: string }
type AnthropicModel = { readonly id?: string; readonly display_name?: string }
type OpenCodeModel = { readonly id?: string }

// OpenAI ChatGPT/Codex subscription tokens don't work with `/v1/models`.
// Use the generated models.dev snapshot instead of a stale hand-written list.
const OPENAI_SUBSCRIPTION_INCLUDE = /^gpt-5/i
const OPENAI_SUBSCRIPTION_EXCLUDE = /chat-latest/i
const openAiSubscriptionModels = (): ReadonlyArray<string> =>
  catalogModelIdsForProvider("openai").filter(
    (id) => OPENAI_SUBSCRIPTION_INCLUDE.test(id) && !OPENAI_SUBSCRIPTION_EXCLUDE.test(id),
  )

export const ModelRegistryLive = Layer.effect(
  ModelRegistry,
  Effect.gen(function* () {
    const settings = yield* SettingsStore
    const auth = yield* AuthStore
    const http = yield* HttpClient.HttpClient

    const getJson = (req: HttpClientRequest.HttpClientRequest) =>
      http.execute(req).pipe(
        Effect.flatMap((r) => r.json),
        Effect.scoped,
      )

    // The credential + a usable secret string for a provider's list call.
    const creds = (
      p: Provider,
    ): Effect.Effect<{ cred: Credential; key: string } | undefined> =>
      Effect.all([auth.get(p), auth.resolveKey(p).pipe(Effect.orElseSucceed(() => undefined))]).pipe(
        Effect.map(([cred, key]) =>
          cred !== undefined && key !== undefined
            ? { cred, key: Redacted.value(key) }
            : undefined,
        ),
      )

    // A logged-in provider whose live `/models` call failed or returned nothing
    // falls back to the bundled models.dev snapshot, so a single API outage
    // never empties the picker. Unconfigured providers stay empty (they
    // early-return [] before this) so the picker only shows providers in use.
    const orCatalog = (p: Provider, live: ReadonlyArray<ModelInfo>): ModelInfo[] =>
      live.length > 0 ? [...live] : [...catalogModelsForProvider(p)]

    const listGoogle = Effect.gen(function* () {
      const c = yield* creds("google")
      if (c === undefined) return [] as ModelInfo[]
      const json = yield* getJson(
        HttpClientRequest.get(
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
        ).pipe(HttpClientRequest.setHeader("x-goog-api-key", c.key)),
      ).pipe(
        Effect.catchAll((e) =>
          Effect.as(
            Effect.logWarning(`google model list failed (${String(e)}); using bundled catalogue`),
            { models: [] as ReadonlyArray<GoogleModel> },
          ),
        ),
      )
      const models = (json as { models?: ReadonlyArray<GoogleModel> }).models ?? []
      const out: ModelInfo[] = []
      for (const m of models) {
        if (m.name === undefined) continue
        const methods = m.supportedGenerationMethods ?? []
        if (!methods.includes("generateContent")) continue
        if (GOOGLE_EXCLUDE.test(m.name)) continue
        const modelId = m.name.replace(/^models\//, "")
        out.push({
          provider: "google",
          modelId,
          displayName: m.displayName ?? modelId,
          contextWindow: m.inputTokenLimit ?? contextWindowFor("google", modelId),
        })
      }
      return orCatalog("google", out)
    })

    const listOpenAi = Effect.gen(function* () {
      const c = yield* creds("openai")
      if (c === undefined) return [] as ModelInfo[]
      if (c.cred.type === "oauth") {
        return openAiSubscriptionModels().map((modelId) => ({
          provider: "openai" as const,
          modelId,
          displayName: modelId,
          contextWindow: contextWindowFor("openai", modelId),
        }))
      }
      const json = yield* getJson(
        HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${c.key}`),
        ),
      ).pipe(
        Effect.catchAll((e) =>
          Effect.as(
            Effect.logWarning(`openai model list failed (${String(e)}); using bundled catalogue`),
            { data: [] as ReadonlyArray<OpenAiModel> },
          ),
        ),
      )
      const data = (json as { data?: ReadonlyArray<OpenAiModel> }).data ?? []
      const out: ModelInfo[] = []
      for (const m of data) {
        if (m.id === undefined) continue
        if (!OPENAI_INCLUDE.test(m.id)) continue
        if (OPENAI_EXCLUDE.test(m.id)) continue
        out.push({
          provider: "openai",
          modelId: m.id,
          displayName: m.id,
          contextWindow: contextWindowFor("openai", m.id),
        })
      }
      return orCatalog("openai", out)
    })

    const listAnthropic = Effect.gen(function* () {
      const c = yield* creds("anthropic")
      if (c === undefined) return [] as ModelInfo[]
      // OAuth subscriptions authenticate with a Bearer token + the oauth beta
      // flag; API keys use `x-api-key`. Either way `anthropic-version` is set.
      const authed =
        c.cred.type === "oauth"
          ? HttpClientRequest.setHeaders({
              Authorization: `Bearer ${c.key}`,
              "anthropic-beta": "oauth-2025-04-20",
            })
          : HttpClientRequest.setHeader("x-api-key", c.key)
      const json = yield* getJson(
        HttpClientRequest.get("https://api.anthropic.com/v1/models?limit=1000").pipe(
          authed,
          HttpClientRequest.setHeader("anthropic-version", "2023-06-01"),
        ),
      ).pipe(
        Effect.catchAll((e) =>
          Effect.as(
            Effect.logWarning(`anthropic model list failed (${String(e)}); using bundled catalogue`),
            { data: [] as ReadonlyArray<AnthropicModel> },
          ),
        ),
      )
      const data = (json as { data?: ReadonlyArray<AnthropicModel> }).data ?? []
      const out: ModelInfo[] = []
      for (const m of data) {
        if (m.id === undefined) continue
        out.push({
          provider: "anthropic",
          modelId: m.id,
          displayName: m.display_name ?? m.id,
          contextWindow: contextWindowFor("anthropic", m.id),
        })
      }
      return orCatalog("anthropic", out)
    })

    const listOpenCode = Effect.gen(function* () {
      const c = yield* creds("opencode")
      if (c === undefined) return [] as ModelInfo[]
      const json = yield* getJson(
        HttpClientRequest.get("https://opencode.ai/zen/go/v1/models").pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${c.key}`),
        ),
      ).pipe(
        Effect.catchAll((e) =>
          Effect.as(
            Effect.logWarning(`opencode model list failed (${String(e)}); using bundled catalogue`),
            { data: [] as ReadonlyArray<OpenCodeModel> },
          ),
        ),
      )
      const data = (json as { data?: ReadonlyArray<OpenCodeModel> }).data ?? []
      const out: ModelInfo[] = []
      for (const m of data) {
        if (m.id === undefined) continue
        out.push({
          provider: "opencode",
          modelId: m.id,
          displayName: m.id,
          contextWindow: contextWindowFor("opencode", m.id),
        })
      }
      return orCatalog("opencode", out)
    })

    type OllamaTagModel = { readonly name?: string }

    const listOllama = Effect.gen(function* () {
      const c = yield* creds("ollama")
      if (c === undefined) return [] as ModelInfo[]
      const baseUrl =
        c.cred.type === "local" ? (c.cred.baseUrl ?? OLLAMA_DEFAULT_BASE_URL) : OLLAMA_DEFAULT_BASE_URL
      const json = yield* getJson(
        HttpClientRequest.get(`${baseUrl.replace(/\/$/, "")}/api/tags`),
      ).pipe(
        Effect.catchAll((e) =>
          Effect.as(
            Effect.logWarning(`ollama model list failed: ${String(e)}`),
            { models: [] as ReadonlyArray<OllamaTagModel> },
          ),
        ),
      )
      const models = (json as { models?: ReadonlyArray<OllamaTagModel> }).models ?? []
      return models.map((m) => ({
        provider: "ollama" as const,
        modelId: m.name ?? "",
        displayName: m.name ?? "",
        contextWindow: contextWindowFor("ollama", m.name ?? ""),
      })).filter((m) => m.modelId.length > 0)
    })

    return ModelRegistry.of({
      current: settings.get().pipe(
        Effect.map((s) => {
          const { provider, modelId } = parseModel(s.model)
          return { provider, modelId, contextWindow: contextWindowFor(provider, modelId) }
        }),
      ),

      select: (info) =>
        settings
          .update((s) => ({ ...s, model: formatModel(info.provider, info.modelId) }))
          .pipe(
            Effect.as({
              provider: info.provider,
              modelId: info.modelId,
              contextWindow:
                info.contextWindow ?? contextWindowFor(info.provider, info.modelId),
            }),
          ),

      // Each provider list is independently guarded: any unexpected failure
      // degrades that one provider to [] instead of breaking the whole picker.
      // Combined with the per-provider catalogue fallback above, the picker
      // opens with whatever resolved as long as one provider is logged in.
      list: Effect.all(
        [listGoogle, listOpenAi, listAnthropic, listOpenCode, listOllama].map((l) =>
          l.pipe(Effect.orElseSucceed(() => [] as ModelInfo[])),
        ),
      ).pipe(
        Effect.map((lists) =>
          lists.flat().sort((a, b) =>
            a.provider === b.provider
              ? a.modelId.localeCompare(b.modelId)
              : a.provider.localeCompare(b.provider),
          ),
        ),
      ),
    })
  }),
)
