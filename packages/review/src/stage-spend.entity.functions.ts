import { Option } from "effect"
import type { StageStep, StageTotals } from "./stage-spend.entity.js"

/**
 * What a stage's ledger does with a reservation of `amount` under its own `cap`: refuse it when what the stage has
 * settled and the amount could never fit (`Refuse`); wait when they fit but the stage's other open holds take it past
 * the cap, since one of them closing may make room (`Wait`); else hold it (`Claim`). No cap claims every reservation.
 */
export const stageStep = (totals: StageTotals, amount: number, cap: Option.Option<number>): StageStep => Option.match(cap, {
  onNone: () => ({ _tag: "Claim" }),
  onSome: (limit) => totals.settled + amount > limit ? { _tag: "Refuse" }
    : totals.settled + totals.reserved + amount > limit && totals.reserved > 0 ? { _tag: "Wait" }
      : { _tag: "Claim" },
})
