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
 * a call. A request's worst case is held at 2 bytes a token: a review's request is mostly code and English, which
 * DeepSeek's tokenizer reads at 3 or more bytes a token, and at 1 byte a token the hold of each late step (a ~140 KB
 * request, ~$0.045) alone would take a normal review of a 24,000-token diff past its cap.
 */
export const DEFAULT_REVIEW_MODEL: ReviewModel = {
  model: "deepseek/deepseek-v4.1-flash-1017",
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  keyVariable: "VERCEL_API_KEY",
  price: { input: 0.3, output: 1.2, cacheRead: 0.007 },
  maxOutputTokens: 2_048,
  bytesPerToken: 2,
  extra: { providerOptions: { gateway: { order: ["baseten"] } } },
  provider: "vercel.ai_gateway",
}

/**
 * The most a review may spend by default, in USD, the ledger's total cap. Measured on the packs of #645, #650, #653 and
 * #658 at their first heads (130 to 139 KB a request): each call holds about $0.023 at 2 bytes a token; a pass of 16
 * steps, every one with its full 2,048 tokens of output, settles about $0.06 (one cold call, the rest read from the
 * cache) and holds about $0.04 for its last, longer request, so $0.10 would refuse a long review near its end.
 */
export const DEFAULT_MAX_COST = 0.15
