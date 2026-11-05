import { Schema } from "effect"
import { EvalId, EvalPath } from "./identity.entity.js"
import { Task } from "./task.entity.js"
import { Candidate } from "./candidate.entity.js"
import { Transcript } from "./transcript.entity.js"
import { Outcome } from "./outcome.entity.js"
import { Grade } from "./grader.entity.js"
import { TrialSpend } from "./spend.entity.js"

/**
 * One task/candidate/sample attempt. `status` `skipped` is a trial the run's
 * spend budget kept from being measured: one it never started (no output,
 * transcript or spend), or one a send the budget refused stopped (its
 * transcript and spend kept); its `reason` starts with `budget:`. `spend`
 * is what its model sends settled, recorded once it reserved any.
 */
export const Trial = Schema.Struct({
  version: Schema.Literal(1), id: EvalPath, runId: EvalId, suiteId: EvalId,
  task: Task, candidate: Candidate, sample: Schema.Int.check(Schema.isGreaterThan(0)),
  status: Schema.Literals(["running", "completed", "error", "cancelled", "skipped"]),
  startedAt: Schema.Number, endedAt: Schema.Number,
  output: Schema.OptionFromNullOr(Schema.Unknown), evidence: Schema.OptionFromNullOr(Schema.Unknown),
  outcome: Schema.OptionFromNullOr(Outcome), transcript: Transcript,
  reason: Schema.String, grades: Schema.Array(Grade),
  spend: Schema.optionalKey(TrialSpend),
})
export type Trial = typeof Trial.Type
