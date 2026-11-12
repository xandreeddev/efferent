import { Schema } from "effect"
import { liveEvent, Seq, storedEvent } from "@xandreed/core/kernel"
import { Tokens } from "../../contracts/loop/request.entity.js"

/**
 * How the window memory is set up.
 *
 * @public
 */
export interface WindowOptions {
  /** What one request may cost, system text included, by the loop contract's estimate (`estimateRequest`). */
  readonly budgetTokens: number
  /** The share of the budget from which a request counts as pressure. 0.8 when left out. */
  readonly pressureAt?: number
}

/**
 * The data of `plugin.window.dropped`: every message at or before `through` is left out of the requests that follow.
 *
 * @public
 */
export const WindowDroppedData = Schema.Struct({ through: Seq })
export type WindowDroppedData = typeof WindowDroppedData.Type

/**
 * `plugin.window.dropped`: whole turns left the window, oldest first. Stored; a reader that does not know it may skip it.
 *
 * @public
 */
export const windowDroppedEvent = storedEvent("window", "dropped", { data: WindowDroppedData, skippable: true })

/**
 * The data of `plugin.window.pressure`: the request that came close to the budget.
 *
 * @public
 */
export const WindowPressureData = Schema.Struct({ estimatedTokens: Tokens, budgetTokens: Tokens })
export type WindowPressureData = typeof WindowPressureData.Type

/**
 * `plugin.window.pressure`: a request was sent close to the budget. Live only.
 *
 * @public
 */
export const windowPressureEvent = liveEvent("window", "pressure", { data: WindowPressureData })

/**
 * The window memory was given a budget that is no budget: not a finite number, or less than one token.
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
