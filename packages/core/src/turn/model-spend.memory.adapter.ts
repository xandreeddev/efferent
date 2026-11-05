import { Effect, Layer, Ref, Result } from "effect"
import { SpendHoldId } from "../domain/model-spend.entity.js"
import type { ModelSpendExceeded, SpendHold, SpendLedger } from "../domain/model-spend.entity.js"
import { emptySpendLedger, forgetSpend, releaseSpend, reserveSpend, settleSpend, spendTotalsOf } from "../domain/model-spend.entity.functions.js"
import { randomUuid } from "../internal/random-id.entity.functions.js"
import { ModelSpend } from "../ports/model-spend.port.js"

/**
 * A `ModelSpend` ledger held in memory: one per call, starting empty. Its
 * reservations are atomic (one `Ref.modify`), and it never fails as
 * unavailable. It keeps a turn's own entry until the turn is forgotten
 * and its holds are closed, so it stays as large as the turns under way.
 */
const makeModelSpendMemory = Effect.fnUntraced(function* (): Effect.fn.Return<ModelSpend["Service"]> {
  const ledger = yield* Ref.make<SpendLedger>(emptySpendLedger)
  return ModelSpend.of({
    reserve: Effect.fn("model_spend.reserve")(function* (request) {
      const id = SpendHoldId.make(yield* randomUuid)
      return yield* Effect.flatten(Ref.modify(ledger, (state): readonly [Effect.Effect<SpendHold, ModelSpendExceeded>, SpendLedger] => Result.match(reserveSpend(state, request, id), {
        onSuccess: ([hold, next]) => [Effect.succeed(hold), next],
        onFailure: (refused) => [Effect.fail(refused), state],
      })))
    }),
    settle: Effect.fn("model_spend.settle")(function* (hold, cost) {
      yield* Ref.update(ledger, (state) => settleSpend(state, hold.id, cost))
    }),
    release: Effect.fn("model_spend.release")(function* (hold) {
      yield* Ref.update(ledger, (state) => releaseSpend(state, hold.id))
    }),
    forget: Effect.fn("model_spend.forget")(function* (runId) {
      yield* Ref.update(ledger, (state) => forgetSpend(state, runId))
    }),
    totals: Effect.fn("model_spend.totals")(function* (runId) {
      return spendTotalsOf(yield* Ref.get(ledger), runId)
    }),
  })
})

/**
 * The in-memory `ModelSpend` ledger: a fresh one each time the layer is built.
 * Build it once per run of spend (an agent's process, an evaluation run)
 * and pass it to every agent that shares the run's caps.
 *
 * @public
 */
export const ModelSpendMemoryLive: Layer.Layer<ModelSpend> = Layer.effect(ModelSpend, makeModelSpendMemory())
