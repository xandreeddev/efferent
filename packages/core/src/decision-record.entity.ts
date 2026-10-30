import { Schema } from "effect"
import { RunId } from "./domain/run.entity.js"

export const DecisionId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("DecisionId"))
/** One option a decision chose among (a skill, for `skill-selection`), as its record stores it, with no checks. */
export const CandidateId = Schema.String.pipe(Schema.brand("CandidateId"))
export type CandidateId = typeof CandidateId.Type
export const DecisionRecord = Schema.Struct({
  version: Schema.Literal(1),
  id: DecisionId,
  family: Schema.NonEmptyString,
  contextHash: Schema.String,
  candidateHash: Schema.String,
  policyVersion: Schema.String,
  candidates: Schema.Array(Schema.Struct({ id: CandidateId, description: Schema.String })),
  attempts: Schema.Array(Schema.String),
  selection: Schema.OptionFromNullOr(Schema.String),
  validation: Schema.Literals(["accepted", "rejected", "abstained", "failed", "cancelled", "bypassed"]),
  fallback: Schema.OptionFromNullOr(Schema.String),
  applied: Schema.OptionFromNullOr(Schema.String),
  probabilities: Schema.OptionFromNullOr(Schema.Record(Schema.String, Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))))),
})
export type DecisionRecord = typeof DecisionRecord.Type
export const DecisionOutcome = Schema.Struct({
  version: Schema.Literal(1),
  decisionId: DecisionId,
  runId: RunId,
  status: Schema.Literals(["completed", "failed", "cancelled", "incomplete"]),
  toolInvocations: Schema.Array(Schema.String),
  modelAttempts: Schema.Array(Schema.String),
  deliveredSequences: Schema.Array(Schema.Int),
})
export type DecisionOutcome = typeof DecisionOutcome.Type
