import { Schema } from "effect"
import { MemoryObservation, RunKey, TokenUsage } from "@xandreed/core"

/** The last accepted response of one prepared run, independent of billing. */
export const TurnObservation = Schema.Struct({
  observed: Schema.OptionFromNullOr(MemoryObservation),
  usage: Schema.OptionFromNullOr(TokenUsage),
  baseReservedTokens: Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type TurnObservation = typeof TurnObservation.Type

/** What a stored `context.built` froze of its request: the step it planned, its message estimate and reserve. */
export const StoredRequestMeasure = Schema.Struct({
  step: Schema.Int,
  run: RunKey,
  estimatedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reservedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type StoredRequestMeasure = typeof StoredRequestMeasure.Type
