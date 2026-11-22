import type { Redacted } from "effect"
import type { SpendOptions, Timeouts } from "../model-spend/model-spend.entity.js"

/**
 * What a Claude model reached on Anthropic's own Messages API is (`anthropicModel`), through Effect AI's Anthropic
 * client (`@effect/ai-anthropic`).
 *
 * - `model`: the model id (`claude-haiku-4-5`), and the key of its price in `spend.prices`.
 * - `apiKey`: sent as `x-api-key`, read from `Config` by the host (`Config.redacted`).
 * - `baseUrl`: the API's base, `https://api.anthropic.com` by default; another for an Anthropic-compatible endpoint.
 * - `maxOutputTokens`: the output each call is reserved for and sent with as its cap; else the price's `maxOutput`.
 * - `cache`: prompt caching. `5m`, the default, and `1h` mark the request so the provider caches its prefix up to the
 *   last block it can (the API's own placement, its top-level `cache_control`), and reads it back in the next request
 *   of the conversation; `off` marks nothing. A cache's reads and writes are priced on their own (`ModelPrice`).
 * - `effort`: the model thinks before it answers, as much as it judges the request needs at this effort (`low`,
 *   `medium`, `high`; the API's adaptive thinking, `thinking: { type: "adaptive" }` and `output_config.effort`).
 *   Left out, nothing is sent and the model answers at its own default. Its thinking comes back as reasoning parts
 *   carrying their signature in their metadata; a host that sends a part back with that metadata as its options
 *   (within one tool loop, before the calls of the answer it came with) lets the model go on from it.
 * - `timeouts`: how long to wait for the headers and between two events of the answer.
 * - `spend`: how each call charges the `ModelSpend` ledger in context (ADR 0026).
 *
 * @public
 */
export interface AnthropicOptions {
  readonly model: string
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly maxOutputTokens?: number
  readonly cache?: "5m" | "1h" | "off"
  readonly effort?: AnthropicEffort
  readonly timeouts?: Timeouts
  readonly spend: SpendOptions
}

/**
 * How hard a Claude model thinks before it answers, under the API's adaptive thinking.
 *
 * @public
 */
export type AnthropicEffort = "low" | "medium" | "high"

/** The `AiError` module this provider's own failures name (the client's own name `AnthropicClient`). */
export const ANTHROPIC = "Anthropic"
