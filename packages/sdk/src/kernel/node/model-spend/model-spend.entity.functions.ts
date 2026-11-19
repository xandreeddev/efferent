import { Option, Predicate, Result, Schema } from "effect"
import { AiError } from "effect/ai"
import type { ModelSpendExceeded, ModelSpendUnavailable } from "@xandreed/core/kernel"
import { CarriedRefusal, REFUSAL_KEY } from "./model-spend.entity.js"
import type { Charge, ModelPrice, Reach, Reported, SpendOptions } from "./model-spend.entity.js"

/** The price the host gave for `model`, if it gave one. */
export const priceOf = (options: SpendOptions, model: string): Option.Option<ModelPrice> =>
  Object.hasOwn(options.prices, model) ? Option.fromNullishOr(options.prices[model]) : Option.none()

/** The output a call is reserved for, and sent with as its cap: the provider's own option, else the price's `maxOutput`. */
export const outputBoundOf = (asked: Option.Option<number>, price: Option.Option<ModelPrice>): Option.Option<number> =>
  Option.orElse(asked, () => Option.flatMap(price, (found) => Option.fromNullishOr(found.maxOutput)))

/** The most input tokens a request body of `bytes` bytes can hold, at `bytesPerToken` bytes a token at least. */
export const inputTokenBound = (bytes: number, bytesPerToken: number): number => Math.ceil(bytes / bytesPerToken)

/**
 * The most a call can cost at `price`: every input token at the dearest of the input, cache-read and cache-write
 * prices, every output token at the output price (reasoning is output). No usage within those counts costs more.
 */
export const worstCaseOf = (price: ModelPrice, inputTokens: number, outputTokens: number): number =>
  (inputTokens * Math.max(price.input, price.cacheRead ?? price.input, price.cacheWrite ?? price.input) + outputTokens * price.output) / 1_000_000

/**
 * What a call that used `reported` cost at `price`: the uncached input at the input price, the cached shares at their
 * own (the input price when the host gave none), the output at the output price.
 */
export const costOf = (reported: Reported, price: ModelPrice): number => {
  const uncached = Math.max(0, reported.input - reported.cacheRead - reported.cacheWrite)
  return (uncached * price.input + reported.cacheRead * (price.cacheRead ?? price.input) + reported.cacheWrite * (price.cacheWrite ?? price.input) + reported.output * price.output) / 1_000_000
}

/** Why a call is refused before it is sent, with nothing held: it names no model the host priced, or has no output bound. */
export type Unchargeable = "unpriced" | "unbounded"

/**
 * What a call to `model` holds before it is sent, from its request body's size and its output bound: its worst case
 * at the model's price; nothing, for a model the host marked uncapped; or a refusal, for a model with no price, or a
 * priced call with no output bound.
 */
export const chargeOf = (options: SpendOptions, model: string, bodyBytes: number, output: Option.Option<number>): Result.Result<Charge, Unchargeable> =>
  Option.match(priceOf(options, model), {
    onNone: () => (options.uncapped ?? []).includes(model) ? Result.succeed<Charge>({ _tag: "Unheld" }) : Result.fail<Unchargeable>("unpriced"),
    onSome: (price) => Option.match(output, {
      onNone: () => Result.fail<Unchargeable>("unbounded"),
      onSome: (bound) => Result.succeed<Charge>({ _tag: "Held", price, amount: worstCaseOf(price, inputTokenBound(bodyBytes, options.bytesPerToken ?? 1), bound) }),
    }),
  })

/** The amount a charge holds: its worst case, or 0 for an uncapped model. */
export const heldBy = (charge: Charge): number => (charge._tag === "Held" ? charge.amount : 0)

/**
 * What a call's hold is closed at, or none to release it. What the provider reported settles it, whatever came of the
 * call: what it billed when it says, else its usage at the price (an uncapped model's, unpriced, at 0). With nothing
 * reported, how far the request got decides: one that left (`Sent`) may have been billed, so it settles at the amount
 * held; one that never left, or that the provider refused before generating anything, releases.
 */
export const settlementOf = (charge: Charge, reported: Option.Option<Reported>, reach: Reach): Option.Option<number> =>
  Option.match(reported, {
    onSome: (usage) => Option.some(usage.billed ?? (charge._tag === "Held" ? costOf(usage, charge.price) : 0)),
    onNone: () => (reach === "Sent" ? Option.some(heldBy(charge)) : Option.none()),
  })

/** The statuses a refusal before any generation is answered with: a 4xx, but 408, a request that outlived its wait. */
export const isRefusalStatus = (status: number): boolean => status >= 400 && status < 500 && status !== 408

/** The codes Node (on the error's `cause`) and Bun (on the error) give a fetch whose connection never opened. */
const NEVER_CONNECTED: ReadonlyArray<string> = [
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused", "FailedToOpenSocket",
]

const codeOf = (error: unknown): Option.Option<string> =>
  Predicate.isObject(error) ? Option.filter(Option.some(error["code"]), Predicate.isString) : Option.none()

/**
 * Whether a fetch's failure shows that its connection never opened, so nothing was sent: its code, or its cause's,
 * is one a connection that failed to open gives. Any other transport failure may have come after the request left.
 */
export const neverConnected = (error: unknown): boolean =>
  [error, Predicate.isObject(error) ? error["cause"] : undefined].some((value) => Option.exists(codeOf(value), (code) => NEVER_CONNECTED.includes(code)))

/**
 * The failure of a call the ledger refused: a non-retryable `AiError`, in the ledger's words, whose reason carries the
 * refusal itself in its metadata (`spendRefusalOf` reads it back).
 */
export const spendRefused = (refusal: ModelSpendExceeded, module: string, method: string): AiError.AiError =>
  AiError.make({
    module, method,
    reason: new AiError.InvalidRequestError({
      description: refusal.message,
      metadata: { [REFUSAL_KEY]: { _tag: refusal._tag, reason: refusal.reason, cap: refusal.cap, committed: refusal.committed, requested: refusal.requested, message: refusal.message } },
    }),
  })

/** The words for a call refused before it is sent because it cannot be charged. */
const unchargeableWords = (why: Unchargeable, model: string): string =>
  why === "unpriced"
    ? `the model ${model} has no price, so what a call to it costs cannot be held; give it a price, or mark it uncapped`
    : `a call to ${model} names no output bound, so its worst case cannot be held; give the provider maxOutputTokens, or the price a maxOutput`

/** The failure of a call refused before it is sent because it cannot be charged: non-retryable, nothing held. */
export const unchargeable = (why: Unchargeable, model: string, module: string, method: string): AiError.AiError =>
  AiError.make({ module, method, reason: new AiError.InvalidRequestError({ description: unchargeableWords(why, model) }) })

/** The failure of a call whose hold could not be taken because the ledger could not be reached: non-retryable, nothing sent. */
export const ledgerUnavailable = (error: ModelSpendUnavailable, module: string, method: string): AiError.AiError =>
  AiError.make({ module, method, reason: new AiError.UnknownError({ description: `the spend ledger could not be reached, so nothing was sent: ${error.message}` }) })

const decodeCarried = Schema.decodeUnknownOption(CarriedRefusal)

/**
 * The ledger's refusal a model call failed with, when it was one: the `ModelSpendExceeded` the ledger gave, read from
 * the `AiError`'s reason. None for any other failure.
 *
 * @public
 */
export const spendRefusalOf = (error: unknown): Option.Option<ModelSpendExceeded> =>
  AiError.isAiError(error) && error.reason._tag === "InvalidRequestError"
    ? Option.map(decodeCarried(error.reason.metadata), (carried) => carried[REFUSAL_KEY])
    : Option.none()

/**
 * Whether a model call failed because the spend ledger refused to hold it: a budget refusal, told apart from every
 * other failure.
 *
 * @public
 */
export const isSpendRefusal = (error: unknown): boolean => Option.isSome(spendRefusalOf(error))
