import { Schema } from "effect"

export const DecisionId = Schema.NonEmptyTrimmedString.pipe(Schema.brand("DecisionId"))
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
  validation: Schema.Literal("accepted", "rejected", "abstained", "failed", "cancelled", "bypassed"),
  fallback: Schema.OptionFromNullOr(Schema.String),
  applied: Schema.OptionFromNullOr(Schema.String),
  probabilities: Schema.OptionFromNullOr(Schema.Record({ key: Schema.String, value: Schema.Number.pipe(Schema.between(0, 1)) })),
})
export type DecisionRecord = typeof DecisionRecord.Type
export const DecisionOutcome = Schema.Struct({
  version: Schema.Literal(1),
  decisionId: DecisionId,
  runId: Schema.String,
  status: Schema.Literal("completed", "failed", "cancelled", "incomplete"),
  toolInvocations: Schema.Array(Schema.String),
  modelAttempts: Schema.Array(Schema.String),
  deliveredSequences: Schema.Array(Schema.Int),
})
export type DecisionOutcome = typeof DecisionOutcome.Type
