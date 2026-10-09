import { Effect } from "effect"
import { EvaluationError } from "./identity.entity.js"
import { fingerprint } from "./grading-context.entity.functions.js"
import type { EvaluationRun } from "./evaluation-run.entity.js"
import type { ReviewBundle } from "./review.entity.js"

export const reviewBundle = (run: EvaluationRun): ReviewBundle => ({ version: 1, runId: run.id, items: run.trials.map((trial) => ({ trialId: trial.id, evidenceFingerprint: fingerprint({ input: trial.task.input, output: trial.output, evidence: trial.evidence, outcome: trial.outcome }), reference: trial.task.reference, approved: false, reviewer: "", rationale: "" })) })
export const approveReviews = (run: EvaluationRun, review: ReviewBundle) => {
  const expected = reviewBundle(run)
  const valid = review.runId === run.id && new Set(review.items.map((item) => item.trialId)).size === review.items.length && review.items.every((item) => expected.items.some((original) => original.trialId === item.trialId && original.evidenceFingerprint === item.evidenceFingerprint) && (!item.approved || (item.reviewer.trim().length > 0 && item.rationale.trim().length > 0)))
  return valid ? Effect.succeed({ ...review, items: review.items.filter((item) => item.approved) }) : Effect.fail(new EvaluationError({ code: "invalid", message: "Reviews require matching evidence, unique trial ids and named approval with rationale" }))
}
