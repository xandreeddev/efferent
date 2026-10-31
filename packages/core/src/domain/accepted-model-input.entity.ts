import { Schema } from "effect"
import { ModelSelection } from "./model-selection.entity.js"

/**
 * Calibration evidence from one accepted model response, separate from billed
 * usage. An absent model or usable positive input count clears prior evidence.
 *
 * @public
 */
export const AcceptedModelInput = Schema.Struct({
  model: Schema.OptionFromNullOr(ModelSelection),
  inputTokens: Schema.OptionFromNullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))),
})
export type AcceptedModelInput = typeof AcceptedModelInput.Type
