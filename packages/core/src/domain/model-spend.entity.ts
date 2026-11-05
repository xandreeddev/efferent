import { Schema } from "effect"
import { RunId } from "./run.entity.js"

/**
 * An amount of model spend, in the currency of the host's `ModelPrice`
 * table (usually USD): finite and at least 0.
 *
 * @public
 */
export const SpendAmount = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
export type SpendAmount = typeof SpendAmount.Type

/**
 * Names one reservation, minted by the `ModelSpend` ledger that holds it.
 *
 * @public
 */
export const SpendHoldId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("SpendHoldId"))
export type SpendHoldId = typeof SpendHoldId.Type

/**
 * The caps a reservation must stay under. `turn`: what is settled and held
 * for the reservation's turn (its `runId`); a reservation outside a turn
 * has none to stay under. `total`: what is settled and held in the whole
 * ledger, which is one run of spend (a process, an evaluation run). An
 * absent cap does not limit.
 *
 * @public
 */
export const SpendCaps = Schema.Struct({
  turn: Schema.optionalKey(SpendAmount),
  total: Schema.optionalKey(SpendAmount),
})
export type SpendCaps = typeof SpendCaps.Type

/**
 * What one physical model send asks to hold before it goes out: its worst
 * case `amount`, the turn it is part of (absent outside a turn) and the
 * caps that apply.
 *
 * @public
 */
export const SpendRequest = Schema.Struct({
  runId: Schema.optionalKey(RunId),
  amount: SpendAmount,
  caps: SpendCaps,
})
export type SpendRequest = typeof SpendRequest.Type

/**
 * A reservation a ledger holds until it is settled at what the send cost
 * or released: its id, its turn and the amount held.
 *
 * @public
 */
export const SpendHold = Schema.Struct({
  id: SpendHoldId,
  runId: Schema.OptionFromNullOr(RunId),
  amount: SpendAmount,
})
export type SpendHold = typeof SpendHold.Type

/**
 * What a turn, or a whole ledger, has spent: `settled`, the observed cost of
 * the sends that ended, and `reserved`, what sends still under way hold.
 *
 * @public
 */
export const SpendTotals = Schema.Struct({
  settled: SpendAmount,
  reserved: SpendAmount,
})
export type SpendTotals = typeof SpendTotals.Type

/**
 * Which cap refused a reservation.
 *
 * @public
 */
export const SpendLimit = Schema.Literals(["turn", "total"])
export type SpendLimit = typeof SpendLimit.Type

/**
 * A reservation that would take what is settled and held past a cap:
 * `reason` names the cap, `cap` its amount, `committed` what was settled and
 * held under it before, and `requested` the amount refused. Nothing is held.
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

/**
 * The state of an in-memory ledger: the holds still open, what was settled
 * in all and per turn (keyed by `runId`), and the turns forgotten while
 * they still had holds open, whose entry goes once the last one closes.
 */
export const SpendLedger = Schema.Struct({
  holds: Schema.Array(SpendHold),
  settled: SpendAmount,
  settledByRun: Schema.Record(Schema.String, SpendAmount),
  ending: Schema.Array(RunId),
})
export type SpendLedger = typeof SpendLedger.Type
