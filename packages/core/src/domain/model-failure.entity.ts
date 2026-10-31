import { Schema } from "effect"
import { ModelLimits } from "./model-catalog.entity.js"
import { ModelSelection } from "./model-selection.entity.js"

/** The semantic failure of a model request, independent of its provider. @public */
export const ModelFailureKind = Schema.Literals([
  "ContextOverflow", "Authentication", "InvalidRequest", "RateLimit", "Quota",
  "Transient", "InvalidResponse", "Timeout", "Unknown",
])
export type ModelFailureKind = typeof ModelFailureKind.Type

/** An explicit failure under core's own metadata namespace, independent of model and usage. @public */
export const ModelFailureStamp = Schema.Struct({ failure: ModelFailureKind })
export type ModelFailureStamp = typeof ModelFailureStamp.Type

/** Known bounds of the actual overflowing route; absent bounds remain unknown. @public */
export const ModelOverflowEvidence = Schema.Struct({ model: ModelSelection, limits: ModelLimits })
export type ModelOverflowEvidence = typeof ModelOverflowEvidence.Type
