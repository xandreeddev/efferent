import {
  contextWindowFor,
  formatModel,
  ModelRegistry,
  parseModel,
  SettingsStore,
  type ModelInfo,
} from "@efferent/core"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import { GOOGLE_API_KEY, OPENAI_API_KEY } from "./clients.js"

/**
 * Runtime model selection + live catalogue. The selection lives in
 * `SettingsStore` (persisted as `"<provider>:<modelId>"`, the single source
 * of truth the router reads each turn). The catalogue is fetched live over
 * raw HTTP and parsed defensively — the `@effect/ai-*` generated list
 * schemas are stricter than the real APIs (e.g. Google's `ListModels` omits
 * `baseModelId`), so decoding through the SDK clients fails; reading the
 * handful of fields we need by hand keeps the list live and drift-proof.
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

const readKey = (name: string): Effect.Effect<string | undefined> =>
  Config.option(Config.redacted(name)).pipe(
    Effect.map(Option.map(Redacted.value)),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )

export const ModelRegistryLive = Layer.effect(
  ModelRegistry,
  Effect.gen(function* () {
    const settings = yield* SettingsStore
    const http = yield* HttpClient.HttpClient

    const getJson = (req: HttpClientRequest.HttpClientRequest) =>
      http.execute(req).pipe(
        Effect.flatMap((r) => r.json),
        Effect.scoped,
      )

    const listGoogle = Effect.gen(function* () {
      const key = yield* readKey(GOOGLE_API_KEY)
      if (key === undefined) return [] as ModelInfo[]
      const json = yield* getJson(
        HttpClientRequest.get(
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
        ).pipe(HttpClientRequest.setHeader("x-goog-api-key", key)),
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
      const key = yield* readKey(OPENAI_API_KEY)
      if (key === undefined) return [] as ModelInfo[]
      const json = yield* getJson(
        HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
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

      list: Effect.zipWith(listGoogle, listOpenAi, (g, o) =>
        [...g, ...o].sort((a, b) =>
          a.provider === b.provider
            ? a.modelId.localeCompare(b.modelId)
            : a.provider.localeCompare(b.provider),
        ),
      ),
    })
  }),
)
