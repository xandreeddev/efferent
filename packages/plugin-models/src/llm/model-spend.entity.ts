import { Effect, Schema } from "effect"
import { ModelPrice, SpendAmount } from "@xandreed/core"

/**
 * The models plugin's `spend` option: a guard on every physical model send
 * (a first attempt, a retry, a fallback's), over the `ModelSpend` ledger
 * among the agent's services. Before a send goes out it reserves the send's
 * worst case; once the attempt ends it settles at what the attempt's
 * reported usage cost, or releases the hold.
 *
 * - `prices`: each model's prices (per million tokens, in the ledger's
 *   currency), keyed by the call's `"<provider>:<modelId>"` selection, as
 *   the telemetry plugin's `prices`. A send to a model the table does not
 *   price is refused (`model.unpriced`).
 * - `turnCap`: the most a turn may settle and hold (`SpendCaps.turn`);
 *   absent, a turn is not capped.
 * - `totalCap`: the most the whole ledger may settle and hold, every turn
 *   and every call outside a turn (`SpendCaps.total`); absent, not capped.
 * - `uncappedOutputTokens`: the output a request that names no output cap
 *   (`max_tokens`, `max_completion_tokens`, `max_output_tokens`) is reserved
 *   for; 32 000 when not given. Set it to the model's real output limit.
 * - `inputBytesPerToken`: the request body's bytes per input token the
 *   worst case assumes; 1 when not given, a bound for any byte-level
 *   tokenizer. A larger value reserves less, at the risk of holding less
 *   than a send can cost.
 *
 * @public
 */
export const ModelSpendOptions = Schema.Struct({
  prices: Schema.Record(Schema.String, ModelPrice),
  turnCap: Schema.optionalKey(SpendAmount),
  totalCap: Schema.optionalKey(SpendAmount),
  uncappedOutputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(32_000))),
  inputBytesPerToken: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
}).annotate({ messageUnexpectedKey: "not a key of the models plugin's spend option" })
export type ModelSpendOptions = typeof ModelSpendOptions.Type

const cap = Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))))

/** The output caps a request body may name, by protocol: Messages and chat completions, chat completions' newer name, the Responses API. */
export const RequestOutputCap = Schema.Struct({
  max_tokens: cap,
  max_completion_tokens: cap,
  max_output_tokens: cap,
})
export type RequestOutputCap = typeof RequestOutputCap.Type

/**
 * How far one attempt's request got, which decides what an attempt whose
 * usage is unknown is charged. `Unsent`: it never reached the provider (the
 * attempt ended before its send, or the connection never opened).
 * `Refused`: the provider answered with an error status, which it does
 * before generating anything. `Sent`: it went out and nothing showed it was
 * refused, so the provider may have generated, and billed, a reply (a
 * timeout, a connection lost on the way, a stream cut before its usage).
 */
export const SendReach = Schema.Literals(["Unsent", "Refused", "Sent"])
export type SendReach = typeof SendReach.Type
