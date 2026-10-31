import { SummaryAttempt } from "./summary-attempt.entity.js"

/** The owner claims a new frontier; concurrent/reentrant callers decline. */
export const claimSummary = (state: SummaryAttempt, frontier: string): readonly [boolean, SummaryAttempt] => SummaryAttempt.match(state, {
  Ready: value => value.attempted.includes(frontier) ? [false, state] as const : [true, { _tag: "Running", frontier, attempted: [...value.attempted, frontier] }] as const,
  Running: () => [false, state] as const,
  Failed: () => [false, state] as const,
})

export const settleSummary = (state: SummaryAttempt, succeeded: boolean): SummaryAttempt => SummaryAttempt.match(state, {
  Ready: () => state,
  Running: value => succeeded ? { _tag: "Ready" as const, attempted: value.attempted } : { _tag: "Failed" as const },
  Failed: () => state,
})
