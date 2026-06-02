import {
  AuthStore,
  contextWindowFor,
  formatModel,
  ModelRegistry,
  parseModel,
  SettingsStore,
  type Credential,
  type ModelInfo,
  type Provider,
} from "@efferent/core"
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

type GoogleModel = {
  readonly name?: string
  readonly displayName?: string
  readonly supportedGenerationMethods?: ReadonlyArray<string>
  readonly inputTokenLimit?: number
}
type OpenAiModel = { readonly id?: string }
type AnthropicModel = { readonly id?: string; readonly display_name?: string }

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
            Effect.logWarning(`google model list failed: ${String(e)}`),
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
      return out
    })

    const listOpenAi = Effect.gen(function* () {
      const c = yield* creds("openai")
      if (c === undefined) return [] as ModelInfo[]
      const json = yield* getJson(
        HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${c.key}`),
        ),
      ).pipe(
        Effect.catchAll((e) =>
          Effect.as(
            Effect.logWarning(`openai model list failed: ${String(e)}`),
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
      return out
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
            Effect.logWarning(`anthropic model list failed: ${String(e)}`),
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
      return out
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

      list: Effect.all([listGoogle, listOpenAi, listAnthropic]).pipe(
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
