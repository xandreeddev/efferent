import type { Context, Effect, Option } from "effect"
import type { ModelSpend, SpendHold } from "@xandreed/core"

/**
 * A stage's ledger: a `ModelSpend` and `keepBack(amount)`, which holds an amount for later (a pass's closing call)
 * only when it fits now, never waiting, and answers none otherwise. A kept-back hold is released with `release`, and
 * no call waits for it to close.
 */
export interface StageLedger extends Context.Service.Shape<typeof ModelSpend> {
  readonly keepBack: (amount: number) => Effect.Effect<Option.Option<SpendHold>>
}
