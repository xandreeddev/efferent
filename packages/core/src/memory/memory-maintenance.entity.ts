import { Schema } from "effect"
import { ModelSelection } from "../domain/model-selection.entity.js"

/** One accepted request's actual model and framework estimates; runtime only. @public */
export const MemoryObservation = Schema.Struct({
  model: ModelSelection,
  inputTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  estimatedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reservedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type MemoryObservation = typeof MemoryObservation.Type
