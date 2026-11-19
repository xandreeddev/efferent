import { Duration, Metric, Schema } from "effect"
import { ModelSpendExceeded, SpendAmount, SpendCaps } from "@xandreed/core"

const PerMillion = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * What a model costs, in USD per million tokens: `input` and `output`, and the dearer or cheaper price of input
 * read from (`cacheRead`) or written to (`cacheWrite`) the provider's cache, each the input price when absent.
 * `maxOutput` is the most a request is reserved for, and sent with as its output cap, when the provider's options
 * name none. An embedding model's price has `output: 0`: its calls give no output, so they hold their input alone.
 *
 * @public
 */
export const ModelPrice = Schema.Struct({
  input: PerMillion,
  output: PerMillion,
  cacheRead: Schema.optionalKey(PerMillion),
  cacheWrite: Schema.optionalKey(PerMillion),
  maxOutput: Schema.optionalKey(Tokens),
})
export type ModelPrice = typeof ModelPrice.Type

/**
 * How a model provider charges the `ModelSpend` ledger in its context (ADR 0026). `prices`: each model's price, by
 * the model id the provider sends; a call to a model with no entry is refused before it is sent, unless `uncapped`
 * names it, when nothing is held and the call is settled at the cost the provider bills, if it says. `caps`: the caps
 * each reservation names, none by default, so the ledger provided decides (an eval run's caps every reservation at its
 * budget). `bytesPerToken`: how many bytes of a request's body the worst case counts as one input token; 1, the
 * default, bounds any tokenizer that reads at least a byte a token.
 *
 * @public
 */
export const SpendOptions = Schema.Struct({
  prices: Schema.Record(Schema.String, ModelPrice),
  uncapped: Schema.optionalKey(Schema.Array(Schema.String)),
  caps: Schema.optionalKey(SpendCaps),
  bytesPerToken: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))),
})
export type SpendOptions = typeof SpendOptions.Type

/**
 * What one call holds before it is sent: `Held`, its worst case at the model's price; or `Unheld`, a model the host
 * marked uncapped, sent with nothing held.
 */
export const Charge = Schema.Union([
  Schema.TaggedStruct("Held", { amount: SpendAmount, price: ModelPrice }),
  Schema.TaggedStruct("Unheld", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type Charge = typeof Charge.Type

/**
 * How far a call's request got, which decides what a call whose usage never came back costs. `Unsent`: it never left
 * (the call ended before its request was made, or the connection never opened). `Refused`: the provider answered it
 * with a refusal status (4xx but 408) before generating anything. `Sent`: it left and nothing says it was refused, so
 * the provider may have generated, and billed, an answer (a stream cut, an interruption, a timeout, a 5xx).
 */
export const Reach = Schema.Literals(["Unsent", "Refused", "Sent"])
export type Reach = typeof Reach.Type

/**
 * What a provider reported a call used, once the call's answer was whole: the tokens, in Effect AI's counts (`input`
 * holds the cached shares too), and what the provider billed for it, when it says (the gateway does).
 */
export interface Reported {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly billed: number | undefined
}

/**
 * The key, in an `AiError` reason's metadata, under which a spend refusal is carried: Effect AI sets an `AiError`'s
 * `cause` to its reason, so the ledger's `ModelSpendExceeded` rides, encoded, in the reason's metadata.
 */
export const REFUSAL_KEY = "ModelSpend"

/** The ledger's refusal, read back from a reason's metadata. */
export const CarriedRefusal = Schema.Struct({ [REFUSAL_KEY]: ModelSpendExceeded })

/**
 * How long a provider waits for a response's headers (`response`), and between two pieces of its body (`idle`),
 * before it gives up on the call as a lost connection (worth another try; the request left, so the call settles at
 * its hold).
 *
 * @public
 */
export interface Timeouts {
  readonly response?: Duration.Input
  readonly idle?: Duration.Input
}

/** The waits a provider gives up after when its options name none: a minute for the headers, two between pieces. */
export const DEFAULT_TIMEOUTS = { response: Duration.minutes(1), idle: Duration.minutes(2) } as const

/*
 * The model calls' counts (ADR 0030), kept here because the charge is the one place that sees every call a provider
 * of the Node entry sends (a host's loop's, a curator's, a summarizer's): calls, tokens and cost come from the same
 * report and settlement, so they cannot disagree. Their attribute keys are the kernel's (`contracts/turn`).
 */

/**
 * Each call the charge held, one per attempt a plan sent, by the model asked (`efferent.model`) and how it ended
 * (`efferent.outcome`, a `CallOutcome`). A call the ledger refused, or one refused before it is sent for want of a
 * price or an output bound, held nothing and is not counted.
 */
export const modelCalls = Metric.counter("efferent.model.calls", {
  description: "model calls a provider sent and charged, each attempt one, by the model asked and how the call ended",
  incremental: true,
})

/**
 * The tokens a provider reported for each call it charged, by model and kind (`efferent.token.kind`: the input not
 * read from the cache, `cache_read`, `cache_write`, `output`, apart as the charge prices them). A call with nothing
 * reported (cut, interrupted, refused) adds none.
 */
export const modelTokens = Metric.counter("efferent.model.tokens", {
  description: "tokens a provider reported for each call it charged, by model and kind",
  incremental: true,
})

/**
 * What the ledger settled each call at, in USD, by model and what it was settled from (`efferent.cost.basis`:
 * `billed`, the provider's bill; `usage`, the reported tokens at the host's price; `held`, the call's worst case,
 * when it was sent and nothing came back, an estimate a dashboard tells apart). The ledger is the one source of a
 * call's cost (ADR 0020): a call that is released, and one whose cost is not known (an uncapped model's, unpriced,
 * with no bill), adds nothing, never 0.
 */
export const modelCost = Metric.counter("efferent.model.cost", {
  description: "what the spend ledger settled each model call at, in USD, by the model priced and the basis of the amount",
  incremental: true,
})
