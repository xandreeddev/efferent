import { Option } from "effect"
import { ModelId, ModelSelection, ProviderId } from "./model-selection.entity.js"

/** Parse `"<provider>:<modelId>"`; model ids may themselves contain `:`. */
export const parseModelSelection = (value: string): Option.Option<ModelSelection> => {
  const at = value.indexOf(":")
  const provider = at > 0 ? value.slice(0, at) : ""
  const modelId = at > 0 ? value.slice(at + 1) : ""
  return provider.length > 0 && modelId.length > 0
    ? Option.some(
        new ModelSelection({
          provider: ProviderId.make(provider),
          modelId: ModelId.make(modelId),
        }),
      )
    : Option.none()
}

export const formatModelSelection = (selection: ModelSelection): string =>
  `${selection.provider}:${selection.modelId}`
