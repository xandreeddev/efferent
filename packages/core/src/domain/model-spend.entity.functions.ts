import { Option, Result, Schema } from "effect"
import { isHarnessError } from "../harness/plugin.entity.functions.js"
import { ModelSpendExceeded } from "./model-spend.entity.js"
import type { RunId } from "./run.entity.js"
import type { SpendAmount, SpendHold, SpendHoldId, SpendLedger, SpendLimit, SpendRequest, SpendTotals } from "./model-spend.entity.js"

/** A ledger that holds and has settled nothing. */
export const emptySpendLedger: SpendLedger = { holds: [], settled: 0, settledByRun: {}, ending: [] }

const sum = (amounts: ReadonlyArray<number>): number => amounts.reduce((total, amount) => total + amount, 0)

const sameRun = (runId: Option.Option<RunId>) => (hold: SpendHold): boolean => Option.isSome(runId) && Option.contains(hold.runId, runId.value)

/**
 * What `ledger` holds for one turn (`runId`), or in all (none): what was
 * settled and what open holds still reserve.
 */
export const spendTotalsOf = (ledger: SpendLedger, runId: Option.Option<RunId>): SpendTotals => Option.match(runId, {
  onNone: () => ({ settled: ledger.settled, reserved: sum(ledger.holds.map((hold) => hold.amount)) }),
  onSome: (run) => ({
    settled: Object.hasOwn(ledger.settledByRun, run) ? ledger.settledByRun[run] ?? 0 : 0,
    reserved: sum(ledger.holds.filter(sameRun(runId)).map((hold) => hold.amount)),
  }),
})

const committedOf = (totals: SpendTotals): number => totals.settled + totals.reserved

const refusal = (reason: SpendLimit, cap: SpendAmount, committed: number, requested: SpendAmount): ModelSpendExceeded => new ModelSpendExceeded({
  reason, cap, committed, requested,
  message: `the ${reason === "turn" ? "turn's" : "total"} model spend cap of ${cap} would be passed: ${committed} is settled or held, ${requested} more was asked for`,
})

/** The cap `reason` refuses `request` under, when it is set and `committed` plus the request passes it. */
const overCap = (reason: SpendLimit, cap: SpendAmount | undefined, committed: number, requested: SpendAmount): Option.Option<ModelSpendExceeded> =>
  cap !== undefined && committed + requested > cap ? Option.some(refusal(reason, cap, committed, requested)) : Option.none()

/**
 * Hold `request.amount` under the id `id` when it keeps the turn's
 * settled and held spend within `caps.turn` (a request with a `runId` only)
 * and the ledger's within `caps.total`; the turn's cap is checked first. A
 * refusal holds nothing.
 */
export const reserveSpend = (ledger: SpendLedger, request: SpendRequest, id: SpendHoldId): Result.Result<readonly [SpendHold, SpendLedger], ModelSpendExceeded> => {
  const runId = Option.fromNullishOr(request.runId)
  const refused = Option.orElse(
    Option.flatMap(runId, () => overCap("turn", request.caps.turn, committedOf(spendTotalsOf(ledger, runId)), request.amount)),
    () => overCap("total", request.caps.total, committedOf(spendTotalsOf(ledger, Option.none())), request.amount),
  )
  return Option.match(refused, {
    onSome: Result.fail,
    onNone: () => {
      const hold: SpendHold = { id, runId, amount: request.amount }
      return Result.succeed([hold, { ...ledger, holds: [...ledger.holds, hold] }] as const)
    },
  })
}

/**
 * Drop the per-turn entry of every forgotten turn (`ending`) that holds
 * nothing any more: its settled spend stays in the ledger's total.
 */
const pruned = (ledger: SpendLedger): SpendLedger => {
  const done = ledger.ending.filter((run) => !ledger.holds.some((hold) => Option.contains(hold.runId, run)))
  return done.length === 0 ? ledger : {
    ...ledger,
    settledByRun: Object.fromEntries(Object.entries(ledger.settledByRun).filter(([run]) => !done.some((ended) => ended === run))),
    ending: ledger.ending.filter((run) => !done.includes(run)),
  }
}

/**
 * Close the hold `id` at `cost`, which counts as settled for its turn and
 * in all, whether below or above the amount held. A hold the ledger no
 * longer has (settled or released already) leaves it as it is. Closing a
 * forgotten turn's last hold drops the turn's entry.
 */
export const settleSpend = (ledger: SpendLedger, id: SpendHoldId, cost: SpendAmount): SpendLedger => Option.match(Option.fromNullishOr(ledger.holds.find((hold) => hold.id === id)), {
  onNone: () => ledger,
  onSome: (hold) => pruned({
    ...ledger,
    holds: ledger.holds.filter((open) => open.id !== id),
    settled: ledger.settled + cost,
    settledByRun: Option.match(hold.runId, {
      onNone: () => ledger.settledByRun,
      onSome: (run) => ({ ...ledger.settledByRun, [run]: (Object.hasOwn(ledger.settledByRun, run) ? ledger.settledByRun[run] ?? 0 : 0) + cost }),
    }),
  }),
})

/**
 * Drop the hold `id` with nothing settled; a hold the ledger no longer has
 * leaves it as it is. Releasing a forgotten turn's last hold drops the
 * turn's entry.
 */
export const releaseSpend = (ledger: SpendLedger, id: SpendHoldId): SpendLedger =>
  ledger.holds.some((hold) => hold.id === id) ? pruned({ ...ledger, holds: ledger.holds.filter((hold) => hold.id !== id) }) : ledger

/**
 * Forget the turn `runId` once it has ended: its per-turn entry goes now,
 * or, while it still has holds open, when the last of them closes; until
 * then it keeps counting toward the turn's cap. What it settled stays in
 * the ledger's total. A turn the ledger has nothing for leaves it as it is.
 */
export const forgetSpend = (ledger: SpendLedger, runId: RunId): SpendLedger =>
  ledger.ending.includes(runId) ? ledger : pruned({ ...ledger, ending: [...ledger.ending, runId] })

const ExceededShape = Schema.Struct(ModelSpendExceeded.fields)
const isExceeded = Schema.is(ExceededShape)

/**
 * The cap refusal a failure carries: a `ModelSpendExceeded` itself, or the
 * `HarnessError` (code `model.spend`) a turn fails with when the models
 * plugin's spend guard refused a send, whose cause it is. Matched by tag and
 * fields, whichever copy of core made it.
 *
 * @public
 */
export const modelSpendExceededOf = (error: unknown): Option.Option<typeof ExceededShape.Type> =>
  isExceeded(error) ? Option.some(error) : isHarnessError(error) && isExceeded(error.cause) ? Option.some(error.cause) : Option.none()
