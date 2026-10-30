import { Option } from "effect"
import type { StepPlan, TokenUsage } from "@xandreed/core"

/**
 * What `runSteps` keeps across the steps of one run, in one `Ref`: the plan
 * of the step planned last (a step's model, messages and tool choice come
 * from one plan), the usage of the last provider call (a planned step's
 * does not count), and how many steps started. Durable results are read
 * from the request when the step settles. Its updates are
 * the pure functions of `step-ledger.entity.functions.ts`. Not a schema:
 * a plan holds the step's `LanguageModel`.
 */
export interface StepLedger {
  readonly plan: Option.Option<{ readonly step: number; readonly plan: StepPlan }>
  readonly lastUsage: Option.Option<TokenUsage>
  readonly steps: number
}

/** A run's ledger before its first step. */
export const emptyLedger: StepLedger = { plan: Option.none(), lastUsage: Option.none(), steps: 0 }
