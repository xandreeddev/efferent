import { Schema } from "effect"

/**
 * A count of tokens: an estimate or a budget.
 *
 * @public
 */
export const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("Tokens"))
export type Tokens = typeof Tokens.Type
