import { Schema } from "effect"

export const DecisionId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("DecisionId"))
export const DecisionRecord = Schema.Struct({
  version: Schema.Literal(1),
  id: DecisionId,
  family: Schema.NonEmptyString,
  contextHash: Schema.String,
  candidateHash: Schema.String,
  policyVersion: Schema.String,
  candidates: Schema.Array(Schema.Struct({ id: Schema.String, description: Schema.String })),
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
  runId: Schema.String,
  status: Schema.Literals(["completed", "failed", "cancelled", "incomplete"]),
  toolInvocations: Schema.Array(Schema.String),
  modelAttempts: Schema.Array(Schema.String),
  deliveredSequences: Schema.Array(Schema.Int),
})
export type DecisionOutcome = typeof DecisionOutcome.Type
