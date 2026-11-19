import { Schema } from "effect"
import { SpendAmount, SpendHoldId } from "@xandreed/core"

/**
 * What one trial spent: `settled`, the observed cost of the model sends it
 * reserved in its run's `ModelSpend` ledger (a hold still open when the
 * trial settled is not counted). A trial that reserved nothing has none
 * recorded: what it spent is unknown, not zero.
 *
 * @public
 */
export const TrialSpend = Schema.Struct({ settled: SpendAmount })
export type TrialSpend = typeof TrialSpend.Type

/**
 * What a run spent: `budget`, the most its trials together may settle and
 * hold (none: the run was not capped), and `settled`, what their sends
 * settled in all. A send settles at its observed cost, so `settled` may pass
 * `budget` by what the last sends cost above what they held.
 *
 * @public
 */
export const RunSpend = Schema.Struct({ budget: Schema.OptionFromNullOr(SpendAmount), settled: SpendAmount })
export type RunSpend = typeof RunSpend.Type

/**
 * A trial's account in its run's ledger: `Unmetered` until its runnable
 * first reserves, then `Metered` with the holds it has open, what it has
 * settled and the refusal under the ledger's total cap that stopped one of
 * its sends, if one did.
 */
export const TrialSpendState = Schema.Union([
  Schema.TaggedStruct("Unmetered", {}),
  Schema.TaggedStruct("Metered", {
    open: Schema.Array(SpendHoldId),
    settled: SpendAmount,
    refusal: Schema.OptionFromNullOr(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type TrialSpendState = typeof TrialSpendState.Type
