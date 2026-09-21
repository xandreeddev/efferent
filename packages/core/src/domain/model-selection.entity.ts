import { Schema } from "effect"

/**
 * A model selection is `"<provider>:<modelId>"` — the human's choice, persisted
 * in settings. The engine treats the provider as an opaque id; which providers
 * exist (and how to build their clients) is the providers package's knowledge.
 */

export const ProviderId = Schema.String.pipe(Schema.brand("ProviderId"))
export type ProviderId = typeof ProviderId.Type

export const ModelId = Schema.String.pipe(Schema.brand("ModelId"))
export type ModelId = typeof ModelId.Type

export class ModelSelection extends Schema.Class<ModelSelection>("ModelSelection")({
  provider: ProviderId,
  modelId: ModelId,
}) {}
