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
 * The default model: DeepSeek V4.1 Flash through the Vercel AI Gateway, asked of Baseten first, 4,096 tokens of output
 * a call (reasoning counts: at 2,048 one turn's answer used 1,925 and another's was cut). A request's worst case is
 * held at 1 byte a token, the ledger's bound for any tokenizer: the request is the pull request's text, so no smaller
 * count is safe.
 */
export const DEFAULT_REVIEW_MODEL: ReviewModel = {
  model: "deepseek/deepseek-v4.1-flash-1017",
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  keyVariable: "VERCEL_API_KEY",
  price: { input: 0.3, output: 1.2, cacheRead: 0.007 },
  maxOutputTokens: 4_096,
  bytesPerToken: 1,
  extra: { providerOptions: { gateway: { order: ["baseten"] } } },
  provider: "vercel.ai_gateway",
}

/**
 * How hard the model reasons in a stage: as the model does by default (`default`, nothing sent), not at all (`none`,
 * the gateway's `reasoning: { enabled: false }`), or at an effort (`reasoning: { effort }`). Measured on DeepSeek V4.1
 * Flash on Baseten through the gateway (2026-11-20): `none` took a call's reasoning from about 3,000 tokens to 0 and
 * changed the prompt's template (25 tokens fewer), so its requests likely do not share a cache with default ones (not
 * measured); `reasoning_effort: "low"`, `reasoning: { effort: "low" }` and `reasoning: { max_tokens: 256 }` were
 * accepted with no change seen (every call of the long probe reasoned about 3,014 tokens, possibly a ceiling).
 */
export const Effort = Schema.Literals(["default", "none", "low", "medium", "high"])
export type Effort = typeof Effort.Type

/**
 * What a review may spend by default, in USD: $0.80 in all, $0.50 on its finder turns, $0.30 on its checks. First sized
 * ($0.50: $0.30 and $0.20) on the packs of #645, #647, #650 and #658 at their first heads: a first request of 130 to
 * 139 KB holds about $0.044 at 1 byte a token, and a request grows with every result read; the longest turn (16 steps)
 * settled $0.040 and its last request (about 300 KB) held about $0.093, plus $0.005 for 4,096 tokens of output. Three
 * turns settle about $0.12 and hold at most three such requests at once, which a stage's ledger lets wait for each
 * other (`stageSpend`) rather than refuse. A check's request is about the pack's size (about $0.05 held); measured, a
 * check that gave its verdict settled about $0.010 (#645, two checks in 13 calls), and one that reasoned four calls
 * without one $0.022 (#595).
 * Focused turns with a 24-call guard and their harvest call settled $0.022 to $0.053 a group (2026-11-20, four gold
 * groups), and $0.020 to $0.074 on #644's nine at its first head, where the ninth was refused part-way at $0.50 (holds
 * grow with every file read whole): the find stage covers about eight or nine groups, a larger pull request's later
 * ones listed as not reviewed. Its four checks at 12 calls settled $0.099 in all ($0.30 checks about twelve).
 */
export const DEFAULT_BUDGET = { total: 0.8, find: 0.5, verify: 0.3 } as const

/** The most a review may spend by default, in USD: `DEFAULT_BUDGET`'s total. */
export const DEFAULT_MAX_COST = DEFAULT_BUDGET.total
