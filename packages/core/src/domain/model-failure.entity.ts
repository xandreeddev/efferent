import { Schema } from "effect"

/** The semantic failure of a model request, independent of its provider. @public */
export const ModelFailureKind = Schema.Literals([
  "ContextOverflow", "Authentication", "InvalidRequest", "RateLimit", "Quota",
  "Transient", "InvalidResponse", "Timeout", "Unknown",
])
export type ModelFailureKind = typeof ModelFailureKind.Type

/** An explicit failure under core's own metadata namespace, independent of model and usage. @public */
export const ModelFailureStamp = Schema.Struct({ failure: ModelFailureKind })
export type ModelFailureStamp = typeof ModelFailureStamp.Type
