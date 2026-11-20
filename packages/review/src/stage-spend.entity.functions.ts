import { Option } from "effect"
import type { StageStep, StageTotals } from "./stage-spend.entity.js"

/**
 * What a stage's ledger does with a reservation of `amount` under its own `cap`, `reserved` what it holds (its calls'
 * and what it keeps back) and `open` how many calls are open (held or being claimed, counted, never read from a sum of
 * amounts): refuse it when what the stage has settled and the amount could never fit (`Refuse`); when what it holds
 * takes it past the cap, wait if a call is open, since its closing makes room (`Wait`), and refuse if none is, since
 * what is kept back does not close for it (`Refuse`); else hold it (`Claim`). No cap claims every reservation.
 */
export const stageStep = (totals: StageTotals, amount: number, cap: Option.Option<number>): StageStep => Option.match(cap, {
  onNone: () => ({ _tag: "Claim" }),
  onSome: (limit) => totals.settled + amount > limit ? { _tag: "Refuse" }
    : totals.settled + totals.reserved + amount > limit ? (totals.open > 0 ? { _tag: "Wait" } : { _tag: "Refuse" })
      : { _tag: "Claim" },
})
