import { Option } from "effect"
import type { LogEntry, StepPlan, StepResult, TokenUsage } from "@xandreed/core"
import type { StepLedger } from "./step-ledger.entity.js"

/*
 * The updates of a run's `StepLedger`, pure: `runSteps` applies them with
 * `Ref.update` and reads it with `Ref.get`, and publishes nothing inside
 * them.
 */

/** The plan cached for `step`: none when the step planned last is another, or the plan was dropped. */
export const cachedPlan = (ledger: StepLedger, step: number): Option.Option<StepPlan> =>
  Option.map(Option.filter(ledger.plan, (cached) => cached.step === step), (cached) => cached.plan)

/** `step` is planned: its plan serves its model, its messages and its tool choice. */
export const planned = (step: number, plan: StepPlan) => (ledger: StepLedger): StepLedger =>
  ({ ...ledger, plan: Option.some({ step, plan }) })

/** The plan is dropped: the step is planned again (a request refused over an image is sent once more). */
export const replanned = (ledger: StepLedger): StepLedger => ({ ...ledger, plan: Option.none() })

/** `step` started: the run counts it. */
export const started = (step: number) => (ledger: StepLedger): StepLedger =>
  ({ ...ledger, steps: Math.max(ledger.steps, step + 1) })

/** A provider call answered with `usage`: the next step's plan reads it. */
export const used = (usage: TokenUsage) => (ledger: StepLedger): StepLedger =>
  ({ ...ledger, lastUsage: Option.some(usage) })

/** The tool results of entries recorded under `step`, after its earlier ones. */
export const recorded = (step: number, entries: ReadonlyArray<LogEntry>) => (ledger: StepLedger): StepLedger => {
  const results = stepResultsOf(entries)
  return results.length === 0 ? ledger : { ...ledger, results: new Map([...ledger.results, [step, [...resultsOf(ledger, step), ...results]]]) }
}

/** `step`'s recorded tool results, in log order. */
export const resultsOf = (ledger: StepLedger, step: number): ReadonlyArray<StepResult> => ledger.results.get(step) ?? []

/** The tool results among recorded log entries, as `step.ended` lists them. */
export const stepResultsOf = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<StepResult> => entries.flatMap((entry) =>
  entry.body._tag === "ToolResult" ? [{ entry: entry.id, toolCallId: entry.body.toolCallId, tool: entry.body.toolName, ok: !entry.body.isError }] : [])
