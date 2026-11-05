import { Cause, Effect, Option, Ref } from "effect"
import { ModelSpend } from "@xandreed/core"
import type { ModelSpendUnavailable, SpendAmount } from "@xandreed/core"
import { EvaluationError } from "../domain/identity.entity.js"
import { reasonOf } from "../domain/identity.entity.functions.js"
import type { TrialSpendState } from "../domain/spend.entity.js"
import { budgetStopOf, cappedAtBudget, held, refusalOf, refused, released, reserving, settled, trialSpendOf, unmetered } from "../domain/spend.entity.functions.js"
import type { RunSpendLedger, TrialSpendAccount } from "../ports/evaluation-services.port.js"

const unavailable = (error: ModelSpendUnavailable) =>
  new EvaluationError({ code: "unavailable", message: `The run's spend ledger cannot be read: ${reasonOf(Cause.fail(error))}`, cause: error })

/**
 * One run's view of `ledger`: each trial reserves through its own account,
 * which caps every reservation's total at `budget`, keeps what the trial
 * settles apart, and notes a refusal under the total cap, after which the
 * run starts no more trials.
 */
export const runSpendLedger = Effect.fnUntraced(function* (
  ledger: ModelSpend["Service"],
  budget: Option.Option<SpendAmount>,
): Effect.fn.Return<RunSpendLedger> {
  const stop = yield* Ref.make(Option.none<string>())
  const totals = ledger.totals(Option.none()).pipe(Effect.mapError(unavailable))
  const trial = Effect.gen(function* (): Effect.fn.Return<TrialSpendAccount> {
    const state = yield* Ref.make<TrialSpendState>(unmetered)
    const account = ModelSpend.of({
      // Uninterruptible, as the port asks of its callers: a hold the shared ledger has taken is
      // always in the trial's open holds, so the settlement that closes it counts for the trial.
      reserve: (request) => Effect.uninterruptible(Ref.update(state, reserving).pipe(
        Effect.andThen(ledger.reserve(cappedAtBudget(request, budget))),
        Effect.tap((hold) => Ref.update(state, (current) => held(current, hold.id))),
        Effect.tapErrorTag("ModelSpendExceeded", (error) => error.reason === "total"
          ? Ref.update(state, (current) => refused(current, error.message)).pipe(
              Effect.andThen(Ref.update(stop, Option.orElse(() => Option.some(error.message)))),
            )
          : Effect.void),
      )),
      settle: (hold, cost) => ledger.settle(hold, cost).pipe(Effect.andThen(Ref.update(state, (current) => settled(current, hold.id, cost)))),
      release: (hold) => ledger.release(hold).pipe(Effect.andThen(Ref.update(state, (current) => released(current, hold.id)))),
      forget: ledger.forget,
      totals: ledger.totals,
    })
    return {
      ledger: account,
      spend: Effect.map(Ref.get(state), trialSpendOf),
      refusal: Effect.map(Ref.get(state), refusalOf),
    }
  })
  return {
    totals,
    stopped: Effect.flatMap(Ref.get(stop), (refusal) => Effect.map(totals, (current) => budgetStopOf(refusal, budget, current))),
    trial,
  }
})
