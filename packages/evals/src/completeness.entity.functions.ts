import { Effect, Schema } from "effect"
import { AssessmentError } from "./assessment.entity.js"
import type { Assessment } from "./assessment.usecase.js"
import { ActionAssessment, CompletenessEvidence } from "./completeness.entity.js"

/** The model labels actions; it never sets the denominator or aggregate score. */
export const assessCompleteness = (evidence: CompletenessEvidence, raw: ReadonlyArray<ActionAssessment>): Effect.Effect<Assessment, AssessmentError> => Effect.gen(function* () {
  yield* Schema.validate(CompletenessEvidence)(evidence).pipe(Effect.mapError((error) => new AssessmentError({ code: "invalid", message: String(error) })))
  const actions = yield* Schema.validate(Schema.Array(ActionAssessment))(raw).pipe(Effect.mapError((error) => new AssessmentError({ code: "invalid", message: String(error) })))
  if (evidence.required.length === 0) return yield* Effect.fail(new AssessmentError({ code: "unavailable", message: "No applicable required actions" }))
  const ids = actions.map((action) => action.actionId)
  const expected = evidence.required.map((action) => action.id)
  const invalid = new Set(expected).size !== expected.length || new Set(ids).size !== ids.length || ids.length !== expected.length ||
    ids.some((id) => !expected.includes(id)) || actions.some((action) =>
      (action.status !== "matched" && !action.reason.trim()) ||
      action.evidenceRefs.some((ref) => !evidence.evidenceRefs.includes(ref)) ||
      action.tools.some((tool) => !evidence.tools.some((actual) => actual.name === tool.name && actual.invocationId === tool.invocationId && actual.stepId === tool.stepId)))
  if (invalid) return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Completeness needs every action exactly once, valid attribution and explanations for non-matches" }))
  const value = actions.reduce((sum, action) => sum + (action.status === "matched" ? 1 : action.status === "partial" ? 0.5 : 0), 0) / expected.length
  const comment = evidence.required.map((required) => {
    const action = actions.find((entry) => entry.actionId === required.id)!
    const tools = action.tools.map((tool) => `${tool.name} [${tool.invocationId}, ${tool.stepId}]`).join(", ") || "none"
    return `${action.actionId}: ${action.status}; tools: ${tools}.${action.reason ? ` ${action.reason}` : ""}`
  }).join("\n")
  return { metrics: [{ kind: "score", name: "completeness", value, min: 0, max: 1, comment }], reason: comment, references: actions.flatMap((action) => action.evidenceRefs), metadata: { actions } }
})
