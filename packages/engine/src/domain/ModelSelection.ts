import { Option, Schema } from "effect"

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

/** Parse `"<provider>:<modelId>"`; model ids may themselves contain `:`. */
export const parseModelSelection = (s: string): Option.Option<ModelSelection> => {
  const at = s.indexOf(":")
  const provider = at > 0 ? s.slice(0, at) : ""
  const modelId = at > 0 ? s.slice(at + 1) : ""
  return provider.length > 0 && modelId.length > 0
    ? Option.some(
        new ModelSelection({
          provider: ProviderId.make(provider),
          modelId: ModelId.make(modelId),
        }),
      )
    : Option.none()
}

export const formatModelSelection = (m: ModelSelection): string =>
  `${m.provider}:${m.modelId}`
