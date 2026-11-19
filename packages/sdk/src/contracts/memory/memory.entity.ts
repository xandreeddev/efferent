import { Schema } from "effect"

/**
 * A count of tokens: an estimate or a budget.
 *
 * @public
 */
export const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("Tokens"))
export type Tokens = typeof Tokens.Type

/**
 * A memory was given a budget that is no budget: not a finite number, or less than one token.
 *
 * @public
 */
export class InvalidBudget extends Schema.TaggedError<InvalidBudget>()("InvalidBudget", {
  message: Schema.String,
}) {}

/**
 * The current turn alone does not fit the budget: nothing older is left to drop.
 *
 * @public
 */
export class OverBudget extends Schema.TaggedError<OverBudget>()("OverBudget", {
  estimatedTokens: Tokens,
  budgetTokens: Tokens,
  message: Schema.String,
}) {}
