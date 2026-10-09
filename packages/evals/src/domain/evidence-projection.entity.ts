import { Schema } from "effect"
import { EvalId, Version } from "./identity.entity.js"
import { ContextBudget } from "./grading-context.entity.js"

export const EvidenceProjection = Schema.Struct({
  id: EvalId,
  version: Version,
  budget: ContextBudget
})
export type EvidenceProjection = typeof EvidenceProjection.Type
