import { Schema } from "effect"
import { liveEvent, Seq, storedEvent } from "@xandreed/core/kernel"
import { Tokens } from "../../contracts/memory/memory.entity.js"

/**
 * How the window memory is set up.
 *
 * @public
 */
export interface WindowOptions {
  /** What the history may cost, the system text left out (the caller's), by memory's estimate (`estimateTokens`). */
  readonly budgetTokens: number
  /** The share of the budget from which a context counts as pressure. 0.8 when left out. */
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
export const windowDroppedEvent = storedEvent("window", "dropped", { data: WindowDroppedData, skippable: true, tags: ["memory"] })

/**
 * The data of `plugin.window.pressure`: the context that came close to the budget.
 *
 * @public
 */
export const WindowPressureData = Schema.Struct({ estimatedTokens: Tokens, budgetTokens: Tokens })
export type WindowPressureData = typeof WindowPressureData.Type

/**
 * `plugin.window.pressure`: a context was built close to the budget. Live only.
 *
 * @public
 */
export const windowPressureEvent = liveEvent("window", "pressure", { data: WindowPressureData, tags: ["memory"] })

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
