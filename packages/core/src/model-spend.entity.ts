import { Schema } from "effect"

/**
 * An amount of model spend, in the currency of the prices whoever reserves uses (usually USD): finite and at least 0.
 *
 * @public
 */
export const SpendAmount = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
export type SpendAmount = typeof SpendAmount.Type

/**
 * Names one reservation, minted by the ledger that holds it.
 *
 * @public
 */
export const SpendHoldId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("SpendHoldId"))
export type SpendHoldId = typeof SpendHoldId.Type

/**
 * The caps a reservation must stay under. `total`: what is settled and held in the whole ledger, which is one run of
 * spend (a process, an evaluation run). An absent cap does not limit.
 *
 * @public
 */
export const SpendCaps = Schema.Struct({
  total: Schema.optionalKey(SpendAmount),
})
export type SpendCaps = typeof SpendCaps.Type

/**
 * What one model call asks to hold before it is sent: its worst-case `amount`, and the caps that apply.
 *
 * @public
 */
export const SpendRequest = Schema.Struct({
  amount: SpendAmount,
  caps: SpendCaps,
})
export type SpendRequest = typeof SpendRequest.Type

/**
 * A reservation a ledger holds until it is settled at what the call cost, or released: its id and the amount held.
 *
 * @public
 */
export const SpendHold = Schema.Struct({
  id: SpendHoldId,
  amount: SpendAmount,
})
export type SpendHold = typeof SpendHold.Type

/**
 * What a ledger has spent: `settled`, the observed cost of the calls that ended, and `reserved`, what calls still
 * under way hold.
 *
 * @public
 */
export const SpendTotals = Schema.Struct({
  settled: SpendAmount,
  reserved: SpendAmount,
})
export type SpendTotals = typeof SpendTotals.Type

/**
 * Which cap refused a reservation: the ledger's total, the one cap there is.
 *
 * @public
 */
export const SpendLimit = Schema.Literals(["total"])
export type SpendLimit = typeof SpendLimit.Type

/**
 * A reservation that would take what is settled and held past a cap: `reason` names the cap, `cap` its amount,
 * `committed` what was settled and held under it before, and `requested` the amount refused. Nothing is held.
 *
 * @public
 */
export class ModelSpendExceeded extends Schema.TaggedError<ModelSpendExceeded>()("ModelSpendExceeded", {
  reason: SpendLimit,
  cap: SpendAmount,
  committed: SpendAmount,
  requested: SpendAmount,
  message: Schema.String,
}) {}

/**
 * A ledger that could not be read or written (a shared store unreachable).
 *
 * @public
 */
export class ModelSpendUnavailable extends Schema.TaggedError<ModelSpendUnavailable>()("ModelSpendUnavailable", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The state of a ledger kept in memory: the holds still open, what was settled, and the count its next hold's id takes. */
export const SpendLedger = Schema.Struct({
  holds: Schema.Array(SpendHold),
  settled: SpendAmount,
  minted: Schema.Int,
})
export type SpendLedger = typeof SpendLedger.Type
