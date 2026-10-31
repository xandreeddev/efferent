import { Option, Schema } from "effect"
import { MemoryObservation } from "@xandreed/core"
import type { AcceptedModelInput, ModelSelection } from "@xandreed/core"

export const matchingObservation = (model: Option.Option<ModelSelection>, observed: Option.Option<MemoryObservation>): Option.Option<MemoryObservation> =>
  Option.filter(observed, (value) => Option.exists(model, (expected) => expected.provider === value.model.provider && expected.modelId === value.model.modelId))

export const observeAcceptedInput = (
  measurement: { readonly estimatedTokens: number; readonly reservedTokens: number },
  accepted: AcceptedModelInput,
): Option.Option<MemoryObservation> => Option.flatMap(Option.all({ model: accepted.model, inputTokens: accepted.inputTokens }), (actual) =>
  Schema.decodeUnknownOption(MemoryObservation)({ ...actual, ...measurement }))
