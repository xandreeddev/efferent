import { Schema } from "effect"
import { TurnOutcomeKind } from "../domain/turn-vocabulary.entity.js"
import { TurnContextBody } from "../memory/memory-log.entity.js"

/** The TurnContext entries given before memory took the message, in order: recorded right after it. */
const Early = Schema.Array(TurnContextBody)

/**
 * Where one turn stands in `TurnLive`: its message not taken by memory yet
 * (`Waiting`, with the context entries waiting for it), being taken
 * (`Taking`: `persistMessage` is recording it, and context entries still
 * wait), taken as turn `number` (`Taken`; `sectioned` once its turn-tier
 * sections are due), or replied (`Replied`, with the outcome recorded). Its
 * transitions are the pure functions of `turn-phase.entity.functions.ts`.
 */
export const TurnPhase = Schema.Union([
  Schema.TaggedStruct("Waiting", { early: Early }),
  Schema.TaggedStruct("Taking", { early: Early }),
  Schema.TaggedStruct("Taken", { number: Schema.Int, sectioned: Schema.Boolean }),
  Schema.TaggedStruct("Replied", { number: Schema.Int, outcome: TurnOutcomeKind }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type TurnPhase = typeof TurnPhase.Type
