import { Schema } from "effect"

const PerMillion = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * The model a review asks, over an OpenAI-compatible endpoint: its id, the endpoint, the environment variable its key
 * is read from, its price in USD per million tokens (`cacheRead` for input read from the provider's cache), the output
 * cap of each call (reasoning counts), how many bytes of a request the ledger's worst case counts as a token, and the
 * body fields sent as given (the gateway's `providerOptions`).
 */
export const ReviewModel = Schema.Struct({
  model: Schema.String,
  baseUrl: Schema.String,
  keyVariable: Schema.String,
  price: Schema.Struct({ input: PerMillion, output: PerMillion, cacheRead: PerMillion }),
  maxOutputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  bytesPerToken: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)),
  extra: Schema.JsonObject,
  provider: Schema.String,
})
export type ReviewModel = typeof ReviewModel.Type

/**
 * The default model: DeepSeek V4.1 Flash through the Vercel AI Gateway, asked of Baseten first, 2,048 tokens of output
 * a call. A request's worst case is held at 1 byte a token, the ledger's bound for any tokenizer: the request is the
 * pull request's text, so no smaller count is safe.
 */
export const DEFAULT_REVIEW_MODEL: ReviewModel = {
  model: "deepseek/deepseek-v4.1-flash-1017",
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  keyVariable: "VERCEL_API_KEY",
  price: { input: 0.3, output: 1.2, cacheRead: 0.007 },
  maxOutputTokens: 2_048,
  bytesPerToken: 1,
  extra: { providerOptions: { gateway: { order: ["baseten"] } } },
  provider: "vercel.ai_gateway",
}

/**
 * The most a review may spend by default, in USD, the ledger's total cap. Measured on the packs of #645, #647, #650
 * and #658 at their first heads: a first request of 130 to 139 KB holds about $0.044 at 1 byte a token, and a request
 * grows with every result read; the longest live pass (#647, 16 steps) settled $0.040 and its last request (about
 * 300 KB) held about $0.093, so one normal review needs about $0.13, and a cap of $0.10 or $0.15 would refuse it near
 * its end.
 */
export const DEFAULT_MAX_COST = 0.2
