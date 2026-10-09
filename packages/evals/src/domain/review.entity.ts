import { Schema } from "effect"
import { EvalId } from "./identity.entity.js"

export const ReviewItem = Schema.Struct({ trialId: EvalId, evidenceFingerprint: Schema.NonEmptyString, reference: Schema.Unknown, approved: Schema.Boolean, reviewer: Schema.String, rationale: Schema.String })
export const ReviewBundle = Schema.Struct({ version: Schema.Literal(1), runId: EvalId, items: Schema.Array(ReviewItem) })
export type ReviewBundle = typeof ReviewBundle.Type
