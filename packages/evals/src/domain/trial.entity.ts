import { Schema } from "effect"
import { EvalId } from "./identity.entity.js"
import { Task } from "./task.entity.js"
import { Candidate } from "./candidate.entity.js"
import { Transcript } from "./transcript.entity.js"
import { Outcome } from "./outcome.entity.js"
import { Grade } from "./grader.entity.js"

export const Trial = Schema.Struct({
  version: Schema.Literal(1), id: EvalId, runId: EvalId, suiteId: EvalId,
  task: Task, candidate: Candidate, sample: Schema.Int.check(Schema.isGreaterThan(0)),
  status: Schema.Literals(["running", "completed", "error", "cancelled", "skipped"]),
  startedAt: Schema.Number, endedAt: Schema.Number,
  output: Schema.OptionFromNullOr(Schema.Unknown), evidence: Schema.OptionFromNullOr(Schema.Unknown),
  outcome: Schema.OptionFromNullOr(Outcome), transcript: Transcript,
  reason: Schema.String, grades: Schema.Array(Grade),
})
export type Trial = typeof Trial.Type
