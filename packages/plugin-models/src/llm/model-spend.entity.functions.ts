import { Option, Predicate, Schema } from "effect"
import { costOf, errorCodeOf, formatModelSelection, ModelCallUsage } from "@xandreed/core"
import type { ModelPrice, ModelSelection } from "@xandreed/core"
import { RequestOutputCap } from "./model-spend.entity.js"
import type { SendReach } from "./model-spend.entity.js"

/** A call's price, when it names a model the table prices (keyed `"<provider>:<modelId>"`). */
export const spendPriceOf = (prices: Readonly<Record<string, ModelPrice>>, selection: Option.Option<ModelSelection>): Option.Option<ModelPrice> =>
  Option.flatMap(selection, (model) => {
    const key = formatModelSelection(model)
    return Object.hasOwn(prices, key) ? Option.fromNullishOr(prices[key]) : Option.none()
  })

/** The most input tokens a body of `bytes` bytes can hold, at `bytesPerToken` bytes per token. */
export const inputTokenBound = (bytes: number, bytesPerToken: number): number => Math.ceil(bytes / bytesPerToken)

const decodeOutputCap = Schema.decodeUnknownOption(Schema.fromJsonString(RequestOutputCap))

/** The output cap a JSON request body names (the largest, should it name several); none for a body that names none or is not JSON. */
export const requestOutputCapOf = (body: string): Option.Option<number> => Option.flatMap(decodeOutputCap(body), (fields) =>
  Option.fromNullishOr([fields.max_tokens, fields.max_completion_tokens, fields.max_output_tokens]
    .filter((value): value is number => typeof value === "number")
    .reduce<number | undefined>((largest, value) => largest === undefined ? value : Math.max(largest, value), undefined)))

/**
 * The most a send can cost at `price`: every input token at the dearest of
 * the input, cache-read and cache-write prices, every output token at the
 * dearer of the output and reasoning prices. No usage within those counts
 * costs more (`costOf`).
 */
export const worstCaseCost = (inputTokens: number, outputTokens: number, price: ModelPrice): number =>
  (inputTokens * Math.max(price.input, price.cacheRead, price.cacheWrite) + outputTokens * Math.max(price.output, price.reasoning ?? price.output)) / 1_000_000

/**
 * What an ended attempt settles at, or none to release its hold. Known
 * usage settles at its cost, however the attempt ended. Otherwise what the
 * request reached decides: a request that went out (`Sent`) may have cost
 * up to its worst case whether it completed, failed or was interrupted, so
 * it settles at the amount `held` (or more, should the part of its usage
 * reported already cost more); one that was never sent or that the
 * provider refused settles at the cost of the usage it reported, and
 * releases its hold when it reported none.
 */
export const spendSettlementOf = (usage: ModelCallUsage, reach: SendReach, held: number, price: ModelPrice): Option.Option<number> => {
  const billable = reach === "Sent"
  return ModelCallUsage.match(usage, {
    Known: (known) => Option.some(costOf(known.usage, price)),
    Partial: (partial) => Option.some(billable ? Math.max(costOf(partial.usage, price), held) : costOf(partial.usage, price)),
    Unknown: () => billable ? Option.some(held) : Option.none(),
  })
}

/** The statuses a gateway answers with when a request outlived it: the provider may still have generated the reply. */
const GATEWAY_TIMEOUTS: ReadonlyArray<number> = [408, 504, 524]

/** What an error status shows of a request: refused before any generation, but a gateway's timeout, which shows nothing. */
export const reachOfStatus = (status: number): SendReach => GATEWAY_TIMEOUTS.includes(status) ? "Sent" : "Refused"

/** The codes Node (`cause.code`) and Bun (`code`) give a fetch whose connection never opened: refused, a name that does not resolve, no route. */
const NEVER_CONNECTED: ReadonlyArray<string> = [
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused", "FailedToOpenSocket",
]

/**
 * Whether a transport failure (a fetch's error) shows that its connection
 * never opened, so nothing was sent: its code, or its cause's, is one a
 * failed connection gives. Any other transport failure may have come after
 * the request went out.
 */
export const neverConnected = (error: unknown): boolean => [error, Predicate.hasProperty(error, "cause") ? error.cause : undefined]
  .some((value) => Option.exists(errorCodeOf(value), (code) => NEVER_CONNECTED.includes(code)))
