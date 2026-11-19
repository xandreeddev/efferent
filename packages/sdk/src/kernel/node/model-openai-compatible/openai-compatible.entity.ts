import type { Redacted, Schema } from "effect"
import type { SpendOptions, Timeouts } from "../model-spend/model-spend.entity.js"

/**
 * What an OpenAI-compatible chat-completions model is (`openAiCompatibleModel`): one adapter for OpenAI, Gemini's
 * OpenAI-compatible endpoint and the Vercel AI Gateway, which differ by their address and the body fields they take.
 *
 * - `model`: the model id the endpoint takes (`gpt-5-mini`, `gemini-2.5-flash`, `deepseek/deepseek-v4.1-flash-1017`),
 *   and the key of its price in `spend.prices`.
 * - `baseUrl`: the API's base, to which `/chat/completions` is added (`https://api.openai.com/v1`,
 *   `https://generativelanguage.googleapis.com/v1beta/openai`, `https://ai-gateway.vercel.sh/v1`).
 * - `apiKey`: sent as a bearer token, read from `Config` by the host (`Config.redacted`); none for an endpoint that
 *   takes no key (a local server).
 * - `maxOutputTokens`: the output each call is reserved for and sent with as its cap; else the price's `maxOutput`.
 * - `outputField`: the body field that cap is sent in: `max_tokens`, the default, which the gateway and Gemini take,
 *   or `max_completion_tokens`, which OpenAI's reasoning models ask for.
 * - `extra`: body fields sent as given, opaque: the gateway's `providerOptions`, a `prompt_cache_key`, a
 *   `reasoning_effort`. A field a request is made of (`model`, `messages`, `tools`…) is refused, never replaced.
 * - `timeouts`: how long to wait for the headers and between two pieces of the answer.
 * - `spend`: how each call charges the `ModelSpend` ledger in context (ADR 0026).
 * - `provider`: the name a call's span gives the provider (`gen_ai.provider.name`, ADR 0030): `openai` by default;
 *   OpenTelemetry's names for the others are `gcp.gemini` and `deepseek`, and a gateway takes its own.
 *
 * @public
 */
export interface OpenAiCompatibleOptions {
  readonly model: string
  readonly baseUrl: string
  readonly apiKey?: Redacted.Redacted<string>
  readonly maxOutputTokens?: number
  readonly outputField?: "max_tokens" | "max_completion_tokens"
  readonly extra?: Schema.JsonObject
  readonly timeouts?: Timeouts
  readonly spend: SpendOptions
  readonly provider?: string
}

/** The `AiError` module this provider's failures name. */
export const OPENAI_COMPATIBLE = "OpenAiCompatible"
