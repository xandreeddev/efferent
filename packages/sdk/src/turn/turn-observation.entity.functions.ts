import { Option, Schema } from "effect"
import { MemoryObservation, parseModelSelection, StepUsageData } from "@xandreed/core"
import type { AcceptedModelInput, ModelSelection, SessionLogEvent } from "@xandreed/core"
import { StoredRequestMeasure } from "./turn-observation.entity.js"

export const matchingObservation = (model: Option.Option<ModelSelection>, observed: Option.Option<MemoryObservation>): Option.Option<MemoryObservation> =>
  Option.filter(observed, (value) => Option.exists(model, (expected) => expected.provider === value.model.provider && expected.modelId === value.model.modelId))

export const observeAcceptedInput = (
  measurement: { readonly estimatedTokens: number; readonly reservedTokens: number },
  accepted: AcceptedModelInput,
): Option.Option<MemoryObservation> => Option.flatMap(Option.all({ model: accepted.model, inputTokens: accepted.inputTokens }), (actual) =>
  Schema.decodeUnknownOption(MemoryObservation)({ ...actual, ...measurement }))

const decodeUsage = Schema.decodeUnknownOption(StepUsageData)
const decodeMeasure = Schema.decodeUnknownOption(StoredRequestMeasure)

/**
 * The last selected response among these stored events (`step.usage` with a
 * model and a positive input), with the estimate and reserve its step's last
 * `context.built` before it froze: accepted-input evidence that outlives the
 * run that measured it. Rows that do not decode tell nothing.
 */
export const acceptedInputOf = (events: ReadonlyArray<SessionLogEvent>): Option.Option<MemoryObservation> => {
  const usages = events.flatMap((event) => event.kind === "step.usage" ? Option.toArray(Option.map(decodeUsage(event.data), (data) => ({ event, data }))) : [])
  const measures = events.flatMap((event) => event.kind === "context.built" ? Option.toArray(Option.map(decodeMeasure(event.data), (data) => ({ event, data }))) : [])
  return Option.flatMap(Option.fromNullishOr(usages.filter(({ data }) => Option.isSome(data.model) && data.usage.inputTokens > 0).at(-1)), (last) => {
    const measure = Option.fromNullishOr(measures.filter(({ event, data }) => event.seq < last.event.seq && Option.getOrElse(event.turn, () => -1) === Option.getOrElse(last.event.turn, () => -2)
      && data.run === last.data.run && data.step === last.data.step).at(-1))
    const model = Option.flatMap(last.data.model, parseModelSelection)
    return Option.flatMap(Option.all({ measure, model }), ({ measure, model }) => Schema.decodeUnknownOption(MemoryObservation)({
      model, inputTokens: last.data.usage.inputTokens, estimatedTokens: measure.data.estimatedTokens, reservedTokens: measure.data.reservedTokens,
    }))
  })
}
