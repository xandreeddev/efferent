import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { FetchHttpClient } from "@effect/platform"
import { Config, Effect, Layer } from "effect"

/**
 * Google Gemini provider for the `@effect/ai` `LanguageModel` service.
 *
 *   LanguageModel  ←  GoogleLanguageModel.layer({ model })
 *                  ←  GoogleClient.layerConfig({ apiKey })
 *                  ←  FetchHttpClient.layer
 *
 * Replaces the Vercel-AI-SDK `gemini.ts`/`vercelAi.ts`. Context caching
 * (Gemini `cachedContent`) is a follow-up — it rides on the
 * `GoogleLanguageModel.Config` tag's `cachedContent` field.
 */

const ClientLive = GoogleClient.layerConfig({
  apiKey: Config.redacted("GOOGLE_GENERATIVE_AI_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer))

export const GoogleLanguageModelLive = Layer.unwrapEffect(
    Config.string("AGENT_MODEL").pipe(
      Config.withDefault("gemini-3.5-flash"),
      Effect.map((model) => GoogleLanguageModel.layer({ model })),
    ),
  ).pipe(Layer.provide(ClientLive))
