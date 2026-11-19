import { Option, Result } from "effect"
import { ModelSpendExceeded, SpendHoldId } from "./model-spend.entity.js"
import type { SpendAmount, SpendHold, SpendLedger, SpendRequest, SpendTotals } from "./model-spend.entity.js"

/** A ledger that holds and has settled nothing. */
export const emptySpendLedger: SpendLedger = { holds: [], settled: 0, minted: 0 }

const sum = (amounts: ReadonlyArray<number>): number => amounts.reduce((total, amount) => total + amount, 0)

/** What `ledger` has settled, and what its open holds still reserve. */
export const spendTotalsOf = (ledger: SpendLedger): SpendTotals => ({ settled: ledger.settled, reserved: sum(ledger.holds.map((hold) => hold.amount)) })

const refusal = (cap: SpendAmount, committed: number, requested: SpendAmount): ModelSpendExceeded => new ModelSpendExceeded({
  reason: "total", cap, committed, requested,
  message: `the total model spend cap of ${cap} would be passed: ${committed} is settled or held, ${requested} more was asked for`,
})

/**
 * Hold `request.amount` when it keeps the ledger's settled and held spend within `caps.total`, under the next id the
 * ledger mints. A refusal holds nothing and mints nothing.
 */
export const reserveSpend = (ledger: SpendLedger, request: SpendRequest): Result.Result<readonly [SpendHold, SpendLedger], ModelSpendExceeded> => {
  const totals = spendTotalsOf(ledger)
  const committed = totals.settled + totals.reserved
  const cap = request.caps.total
  if (cap !== undefined && committed + request.amount > cap) return Result.fail(refusal(cap, committed, request.amount))
  const hold: SpendHold = { id: SpendHoldId.make(`h${ledger.minted + 1}`), amount: request.amount }
  return Result.succeed([hold, { holds: [...ledger.holds, hold], settled: ledger.settled, minted: ledger.minted + 1 }] as const)
}

/**
 * Close the hold `id` at `cost`, which counts as settled whether below or above the amount held. A hold the ledger no
 * longer has (settled or released already) leaves it as it is.
 */
export const settleSpend = (ledger: SpendLedger, id: SpendHoldId, cost: SpendAmount): SpendLedger => Option.match(Option.fromNullishOr(ledger.holds.find((hold) => hold.id === id)), {
  onNone: () => ledger,
  onSome: () => ({ ...ledger, holds: ledger.holds.filter((open) => open.id !== id), settled: ledger.settled + cost }),
})

/** Drop the hold `id` with nothing settled; a hold the ledger no longer has leaves it as it is. */
export const releaseSpend = (ledger: SpendLedger, id: SpendHoldId): SpendLedger =>
  ledger.holds.some((hold) => hold.id === id) ? { ...ledger, holds: ledger.holds.filter((hold) => hold.id !== id) } : ledger
