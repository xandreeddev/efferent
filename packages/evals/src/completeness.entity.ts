import { Schema } from "effect"

/**
 * Names one action a completeness assessment requires; an assessment labels each by it.
 *
 * @public
 */
export const ActionId = Schema.NonEmptyString.pipe(Schema.brand("ActionId"))
export type ActionId = typeof ActionId.Type
/**
 * Names one tool call of the trace a completeness assessment attributes actions to.
 *
 * @public
 */
export const ToolInvocationId = Schema.NonEmptyString.pipe(Schema.brand("ToolInvocationId"))
export type ToolInvocationId = typeof ToolInvocationId.Type
/**
 * Names the step of the trace a tool call was made in.
 *
 * @public
 */
export const TraceStepId = Schema.NonEmptyString.pipe(Schema.brand("TraceStepId"))
export type TraceStepId = typeof TraceStepId.Type

/** @public */
export const RequiredAction = Schema.Struct({ id: ActionId, description: Schema.NonEmptyString })
export type RequiredAction = typeof RequiredAction.Type
/** @public */
export const ActionToolReference = Schema.Struct({
  name: Schema.NonEmptyString, invocationId: ToolInvocationId, stepId: TraceStepId,
})
/** @public */
export const ActionAssessment = Schema.Struct({
  actionId: ActionId,
  status: Schema.Literals(["matched", "partial", "missing"]),
  tools: Schema.Array(ActionToolReference), evidenceRefs: Schema.Array(Schema.String), reason: Schema.String,
})
export type ActionAssessment = typeof ActionAssessment.Type
/** @public */
export const CompletenessEvidence = Schema.Struct({
  required: Schema.Array(RequiredAction),
  tools: Schema.Array(ActionToolReference),
  evidenceRefs: Schema.Array(Schema.String),
})
export type CompletenessEvidence = typeof CompletenessEvidence.Type
