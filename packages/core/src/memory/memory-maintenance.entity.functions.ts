import { Option, Schema } from "effect"
import { MemoryObservation } from "./memory-maintenance.entity.js"

const usable = Schema.is(MemoryObservation)

/** Scale message estimates upward using one accepted request, with reserves counted once. @public */
export const scaledTokens = (estimate: number, observed: Option.Option<MemoryObservation>): number => Option.match(observed, {
  onNone: () => estimate,
  onSome: (value) => {
    if (!usable(value) || value.estimatedTokens === 0) return estimate
    const factor = Math.max(1, Math.max(0, value.inputTokens - value.reservedTokens) / value.estimatedTokens)
    const scaled = Math.ceil(estimate * factor)
    return Math.max(estimate, Math.min(Number.MAX_SAFE_INTEGER, scaled))
  },
})
