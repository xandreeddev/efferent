import { Effect, Layer, Ref, Result } from "effect"
import type { ModelSpendExceeded, SpendHold, SpendLedger } from "./model-spend.entity.js"
import { emptySpendLedger, releaseSpend, reserveSpend, settleSpend, spendTotalsOf } from "./model-spend.entity.functions.js"
import { ModelSpend } from "./model-spend.port.js"

/**
 * A `ModelSpend` ledger kept in memory, starting empty. A reservation is one `Ref.modify`, so reservations made at
 * once never pass a cap together, and it never fails as unavailable. It keeps only the holds still open.
 *
 * @public
 */
export const makeModelSpendMemory: Effect.Effect<ModelSpend["Service"]> = Effect.map(Ref.make<SpendLedger>(emptySpendLedger), (ledger) => ModelSpend.of({
  reserve: (request) => Effect.flatten(Ref.modify(ledger, (state): readonly [Effect.Effect<SpendHold, ModelSpendExceeded>, SpendLedger] => Result.match(reserveSpend(state, request), {
    onSuccess: ([hold, next]) => [Effect.succeed(hold), next],
    onFailure: (refused) => [Effect.fail(refused), state],
  }))),
  settle: (hold, cost) => Ref.update(ledger, (state) => settleSpend(state, hold.id, cost)),
  release: (hold) => Ref.update(ledger, (state) => releaseSpend(state, hold.id)),
  totals: Effect.map(Ref.get(ledger), spendTotalsOf),
}))

/**
 * The in-memory `ModelSpend` ledger: a fresh one each time the layer is built. Build it once per run of spend and give
 * it to everything that shares the run's cap.
 *
 * @public
 */
export const modelSpendMemory: Layer.Layer<ModelSpend> = Layer.effect(ModelSpend, makeModelSpendMemory)
