import { Schema } from "effect"
import { MemoryObservation, TokenUsage } from "@xandreed/core"

/** The last accepted response of one prepared run, independent of billing. */
export const TurnObservation = Schema.Struct({
  observed: Schema.OptionFromNullOr(MemoryObservation),
  usage: Schema.OptionFromNullOr(TokenUsage),
  baseReservedTokens: Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type TurnObservation = typeof TurnObservation.Type
