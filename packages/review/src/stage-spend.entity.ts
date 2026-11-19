import { Schema } from "effect"

const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/** What a stage of a review has spent: what its closed calls settled, and what its open calls hold. */
export const StageTotals = Schema.Struct({ settled: Amount, reserved: Amount })
export type StageTotals = typeof StageTotals.Type

/** What a stage's ledger does with a reservation: refuse it, wait for an open hold to close, or hold it. */
export const StageStep = Schema.Union([
  Schema.TaggedStruct("Refuse", {}),
  Schema.TaggedStruct("Wait", {}),
  Schema.TaggedStruct("Claim", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type StageStep = typeof StageStep.Type

/**
 * What a review may spend, in USD: in all (`total`), on its passes that find (`find`) and on its checks (`verify`).
 * Each stage's cap is inside the total; a stage waits for an open hold to close before it refuses a call that would
 * fit once that hold is settled.
 */
export const ReviewBudget = Schema.Struct({
  total: Schema.Finite.check(Schema.isGreaterThan(0)),
  find: Schema.Finite.check(Schema.isGreaterThan(0)),
  verify: Schema.Finite.check(Schema.isGreaterThan(0)),
})
export type ReviewBudget = typeof ReviewBudget.Type
