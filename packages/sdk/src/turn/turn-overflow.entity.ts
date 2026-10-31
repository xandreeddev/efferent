import { Schema } from "effect"

/** A strictly tighter input ceiling and the messages' share after fixed reserves. */
export const OverflowBudget = Schema.Struct({
  inputCeiling: Schema.Int.check(Schema.isGreaterThan(0)),
  messageBudget: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type OverflowBudget = typeof OverflowBudget.Type
