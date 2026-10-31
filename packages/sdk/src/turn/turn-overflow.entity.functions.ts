import { Option, Schema } from "effect"
import type { ModelLimits } from "@xandreed/core"
import { OverflowBudget } from "./turn-overflow.entity.js"

const positive = (value: number | undefined): Option.Option<number> =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? Option.some(value) : Option.none()

/** Output is an actual attempted cap when known; an absent cap stays unknown. */
export const tighterOverflowBudget = (previous: number, reserved: number, failedComparable: number, limits: ModelLimits): Option.Option<OverflowBudget> => {
  if (!Number.isSafeInteger(previous) || previous < 1 || !Number.isSafeInteger(reserved) || reserved < 0 || !Number.isSafeInteger(failedComparable) || failedComparable < 1) return Option.none()
  const context = positive(limits.contextWindow)
  const output = positive(limits.maxOutputTokens)
  const bound = Option.map(context, (window) => window - Option.getOrElse(output, () => 0))
  const applicable = Math.min(previous, Option.getOrElse(bound, () => previous))
  const messages = Math.floor(0.8 * Math.min(applicable - reserved, failedComparable))
  return messages > 0 && messages < failedComparable && reserved + messages < previous
    ? Schema.decodeUnknownOption(OverflowBudget)({ inputCeiling: reserved + messages, messageBudget: messages })
    : Option.none()
}
