import { GoogleClient } from "@effect/ai-google"
import { OpenAiClient } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { Config, Effect, Layer, Option, type Redacted } from "effect"

/**
 * Provider clients for the multi-provider router. Both are built
 * unconditionally so the router can switch at runtime, but the API key is
 * *optional* — a missing key yields a client that 401s only when actually
 * used, instead of failing the whole app at layer-build time (a Google-only
 * user must not be blocked by an absent `OPENAI_API_KEY`).
 */

const optionalKey = (
  name: string,
): Config.Config<Redacted.Redacted | undefined> =>
  Config.redacted(name).pipe(Config.option, Config.map(Option.getOrUndefined))

/** Whether the given env var holds a non-empty value. Drives `/model` gating. */
export const hasKey = (name: string): Effect.Effect<boolean> =>
  Config.option(Config.redacted(name)).pipe(
    Effect.map(Option.isSome),
    Effect.orElseSucceed(() => false),
  )

export const GOOGLE_API_KEY = "GOOGLE_GENERATIVE_AI_API_KEY"
export const OPENAI_API_KEY = "OPENAI_API_KEY"

export const GoogleClientLive = GoogleClient.layerConfig({
  apiKey: optionalKey(GOOGLE_API_KEY),
}).pipe(Layer.provide(FetchHttpClient.layer))

export const OpenAiClientLive = OpenAiClient.layerConfig({
  apiKey: optionalKey(OPENAI_API_KEY),
}).pipe(Layer.provide(FetchHttpClient.layer))

/** Both provider clients, ready to back the router + the model catalogue. */
export const ProviderClientsLive = Layer.mergeAll(
  GoogleClientLive,
  OpenAiClientLive,
)
