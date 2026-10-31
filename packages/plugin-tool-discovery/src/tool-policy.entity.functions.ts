import { Option } from "effect"
import type { ToolAdmission, ToolBreaker, ToolPolicy } from "./tool-policy.entity.js"

export const emptyToolAdmission: ToolAdmission = { turn: {}, runs: {} }
const closed: ToolBreaker = { _tag: "Closed", failures: 0 }
const ownValue = <A>(values: Readonly<Record<string, A>>, key: string, fallback: NoInfer<A>): A => Object.hasOwn(values, key) ? values[key] ?? fallback : fallback
const bucketOf = (state: ToolAdmission, run: string) => ownValue(state.runs, run, { calls: {}, breakers: {} })
export const breakerOf = (state: ToolAdmission, run: string, tool: string): ToolBreaker => ownValue(bucketOf(state, run).breakers, tool, closed)

/** Consecutive relevant handler failures; a successful handler resets the streak. */
export const settledBreaker = (held: ToolBreaker, policy: ToolPolicy, outcome: "success" | "failure" | "defect" | "unrelated"): ToolBreaker => {
  if (held._tag === "Tripped" || policy.breakAfter === undefined || outcome === "unrelated") return held
  const failures = outcome === "success" ? 0 : outcome === "defect" || policy.breakOn === "failures" ? held.failures + 1 : held.failures
  return failures >= policy.breakAfter ? { _tag: "Tripped", failures } : { _tag: "Closed", failures }
}

export const settleToolAdmission = (state: ToolAdmission, run: string, tool: string, policy: ToolPolicy, outcome: "success" | "failure" | "defect" | "unrelated"): ToolAdmission => {
  const bucket = bucketOf(state, run)
  return { ...state, runs: { ...state.runs, [run]: { ...bucket, breakers: { ...bucket.breakers, [tool]: settledBreaker(breakerOf(state, run, tool), policy, outcome) } } } }
}

/** Admission is one atomic decision, so simultaneous calls cannot share the final slot. */
export const admitTool = (state: ToolAdmission, run: string, tool: string, policy: ToolPolicy, turnLimit: number, annotationLimit: Option.Option<number>): readonly [Option.Option<"call-limit" | "tool-call-limit" | "run-call-limit" | "tripped">, ToolAdmission] => {
  const bucket = bucketOf(state, run)
  const reason = Object.values(state.turn).reduce((sum, count) => sum + count, 0) >= turnLimit ? Option.some("call-limit" as const)
    : Option.isSome(annotationLimit) && ownValue(state.turn, tool, 0) >= annotationLimit.value ? Option.some("tool-call-limit" as const)
      : policy.maxCallsPerRun !== undefined && ownValue(bucket.calls, tool, 0) >= policy.maxCallsPerRun ? Option.some("run-call-limit" as const)
        : breakerOf(state, run, tool)._tag === "Tripped" ? Option.some("tripped" as const) : Option.none()
  return Option.isSome(reason) ? [reason, state] : [reason, {
    turn: { ...state.turn, [tool]: ownValue(state.turn, tool, 0) + 1 },
    runs: { ...state.runs, [run]: { ...bucket, calls: { ...bucket.calls, [tool]: ownValue(bucket.calls, tool, 0) + 1 } } },
  }]
}

export const trippedMessage = (): string => "This tool has reached its failure limit for this run; use another tool or report what blocked the task"
export const concurrencyMessage = (): string => "This tool cannot run inside the current tool call while its execution limits are occupied; finish the current call before trying again"
export const runCallLimitMessage = (limit: number): string => limit === 0
  ? "This tool is disabled for this run; use another tool or report what blocked the task"
  : `This tool may be called at most ${limit === 1 ? "once" : `${limit} times`} per run; use what its earlier calls returned`
