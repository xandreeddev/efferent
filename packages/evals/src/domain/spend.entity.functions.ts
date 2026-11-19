import { Option } from "effect"
import type { SpendAmount, SpendHoldId, SpendRequest, SpendTotals } from "@xandreed/core"
import { TrialSpendState } from "./spend.entity.js"
import type { RunSpend, TrialSpend } from "./spend.entity.js"

type Metered = Extract<TrialSpendState, { readonly _tag: "Metered" }>

/** A trial's account before its runnable reserves anything. */
export const unmetered: TrialSpendState = { _tag: "Unmetered" }

/** `state` once its runnable has asked to reserve: metered from then on, whatever the ledger answers. */
const metered = (state: TrialSpendState): Metered => TrialSpendState.match(state, {
  Unmetered: (): Metered => ({ _tag: "Metered", open: [], settled: 0, refusal: Option.none() }),
  Metered: (account) => account,
})

/** `close` applied to the account when it holds `id` open; else the account as it is. */
const closing = (state: TrialSpendState, id: SpendHoldId, close: (account: Metered) => Metered): TrialSpendState => TrialSpendState.match(state, {
  Unmetered: (account): TrialSpendState => account,
  Metered: (account): TrialSpendState => account.open.includes(id) ? close({ ...account, open: account.open.filter((open) => open !== id) }) : account,
})

/**
 * `request` with its total cap no higher than `budget`: a run's budget
 * caps every reservation its trials make, under whatever total cap the
 * request names itself.
 */
export const cappedAtBudget = (request: SpendRequest, budget: Option.Option<SpendAmount>): SpendRequest => Option.match(budget, {
  onNone: () => request,
  onSome: (cap) => ({ ...request, caps: { ...request.caps, total: request.caps.total === undefined ? cap : Math.min(request.caps.total, cap) } }),
})

/** The account once its runnable has asked to reserve, before the ledger answers. */
export const reserving = (state: TrialSpendState): TrialSpendState => metered(state)

/** The account once the ledger has held `id` for it. */
export const held = (state: TrialSpendState, id: SpendHoldId): TrialSpendState => {
  const account = metered(state)
  return { ...account, open: [...account.open, id] }
}

/** The account once the ledger's total cap has refused one of its reservations; the first refusal is kept. */
export const refused = (state: TrialSpendState, message: string): TrialSpendState => {
  const account = metered(state)
  return { ...account, refusal: Option.orElse(account.refusal, () => Option.some(message)) }
}

/** The account once its hold `id` settled at `cost`; a hold it no longer has open (closed already, or another's) leaves it as it is. */
export const settled = (state: TrialSpendState, id: SpendHoldId, cost: SpendAmount): TrialSpendState =>
  closing(state, id, (account) => ({ ...account, settled: account.settled + cost }))

/** The account once its hold `id` was released with nothing settled. */
export const released = (state: TrialSpendState, id: SpendHoldId): TrialSpendState =>
  closing(state, id, (account) => account)

/** What the trial spent, once it reserved anything; none while it reserved nothing. */
export const trialSpendOf = (state: TrialSpendState): Option.Option<TrialSpend> => TrialSpendState.match(state, {
  Unmetered: () => Option.none(),
  Metered: (account) => Option.some({ settled: account.settled }),
})

/** The refusal under the ledger's total cap that stopped one of the trial's sends. */
export const refusalOf = (state: TrialSpendState): Option.Option<string> => TrialSpendState.match(state, {
  Unmetered: () => Option.none(),
  Metered: (account) => account.refusal,
})

/**
 * Why a run schedules no more trials: the refusal under its ledger's total
 * cap that stopped a send, else, once what it settled reached its budget,
 * that it did; none while it may spend.
 */
export const budgetStopOf = (refusal: Option.Option<string>, budget: Option.Option<SpendAmount>, totals: SpendTotals): Option.Option<string> =>
  Option.orElse(refusal, () => Option.flatMap(budget, (cap) => totals.settled >= cap
    ? Option.some(`the run's spend budget of ${cap} is reached: ${totals.settled} is settled`)
    : Option.none()))

/**
 * The run's spend for its report: recorded when it had a budget or any of
 * its trials reserved; none otherwise, since a run that metered nothing
 * measured no spend.
 */
export const runSpendOf = (
  budget: Option.Option<SpendAmount>,
  totals: SpendTotals,
  trials: ReadonlyArray<{ readonly spend?: TrialSpend }>,
): Option.Option<RunSpend> =>
  Option.isSome(budget) || trials.some((trial) => trial.spend !== undefined)
    ? Option.some({ budget, settled: totals.settled })
    : Option.none()
