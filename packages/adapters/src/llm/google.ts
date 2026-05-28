import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { FetchHttpClient } from "@effect/platform"
import { LlmInfo } from "@agent/core"
import { Config, Effect, Layer } from "effect"

/**
 * Google Gemini provider for the `@effect/ai` `LanguageModel` service
 * (plus a thin `LlmInfo` for the TUI status bar).
 *
 *   LanguageModel  ←  GoogleLanguageModel.layer({ model })
 *                  ←  GoogleClient.layerConfig({ apiKey })
 *                  ←  FetchHttpClient.layer
 *
 * Replaces the Vercel-AI-SDK `gemini.ts`/`vercelAi.ts`. Context caching
 * (Gemini `cachedContent`) is a follow-up — it rides on the
 * `GoogleLanguageModel.Config` tag's `cachedContent` field.
 */

const modelConfig = Config.string("AGENT_MODEL").pipe(
  Config.withDefault("gemini-3.5-flash"),
)

const ClientLive = GoogleClient.layerConfig({
  apiKey: Config.redacted("GOOGLE_GENERATIVE_AI_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer))

export const GoogleLanguageModelLive = Layer.unwrapEffect(
  modelConfig.pipe(Effect.map((model) => GoogleLanguageModel.layer({ model }))),
).pipe(Layer.provide(ClientLive))

const LlmInfoLive = Layer.effect(
  LlmInfo,
  modelConfig.pipe(
    Effect.map((modelId) => ({
      metadata: Effect.succeed({ modelId, contextWindow: 1_000_000 }),
    })),
  ),
)

/** Smart-tier Gemini bundle: provides `LanguageModel` + `LlmInfo`. */
export const GoogleLive = Layer.mergeAll(GoogleLanguageModelLive, LlmInfoLive)
