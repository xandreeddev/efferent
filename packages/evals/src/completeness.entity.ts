import { Schema } from "effect"

export const RequiredAction = Schema.Struct({ id: Schema.NonEmptyString, description: Schema.NonEmptyString })
export type RequiredAction = typeof RequiredAction.Type
export const ActionToolReference = Schema.Struct({
  name: Schema.NonEmptyString, invocationId: Schema.NonEmptyString, stepId: Schema.NonEmptyString,
})
export const ActionAssessment = Schema.Struct({
  actionId: Schema.NonEmptyString,
  status: Schema.Literal("matched", "partial", "missing"),
  tools: Schema.Array(ActionToolReference), evidenceRefs: Schema.Array(Schema.String), reason: Schema.String,
})
export type ActionAssessment = typeof ActionAssessment.Type
export const CompletenessEvidence = Schema.Struct({
  required: Schema.Array(RequiredAction),
  tools: Schema.Array(ActionToolReference),
  evidenceRefs: Schema.Array(Schema.String),
})
export type CompletenessEvidence = typeof CompletenessEvidence.Type
