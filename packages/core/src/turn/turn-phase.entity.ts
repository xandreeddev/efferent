import { Schema } from "effect"
import { RunOrdinal } from "../domain/run.entity.js"
import { TurnOutcomeKind } from "../domain/turn-vocabulary.entity.js"
import { LogEntry, TurnContextBody } from "../memory/memory-log.entity.js"
// The declarations this module emits name the user message through this import, not another package.
import type { UserMessage } from "./user-message.entity.js"

/** The TurnContext entries given before memory took the message, in order: recorded right after it. */
const Early = Schema.Array(TurnContextBody)

/**
 * Where one turn stands in `TurnLive`: its message not taken by memory yet
 * (`Waiting`, with the context entries waiting for it), being taken
 * (`Taking`: `persistMessage` is recording it, and context entries still
 * wait), taken as turn `number` (`Taken`; `sectioned` once its turn-tier
 * sections are due; `runs`, the ordinal its next run of the step loop
 * takes), or replied (`Replied`, with the outcome recorded, and `held`, the
 * memory entries held for the turn's closing commit: its reply, and what
 * memory recorded after it, in order). Its transitions are the pure
 * functions of `turn-phase.entity.functions.ts`.
 */
export const TurnPhase = Schema.Union([
  Schema.TaggedStruct("Waiting", { early: Early }),
  Schema.TaggedStruct("Taking", { early: Early }),
  Schema.TaggedStruct("Taken", { number: Schema.Int, sectioned: Schema.Boolean, runs: RunOrdinal }),
  Schema.TaggedStruct("Replied", { number: Schema.Int, outcome: TurnOutcomeKind, held: Schema.Array(LogEntry) }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type TurnPhase = typeof TurnPhase.Type

/**
 * What a reply does (`reply`): `Record` the turn's reply (TurnEnded) as
 * turn `number` and publish `turn.ended`; `Hold` these entries again for the
 * closing commit, the reply among them downgraded to failed; or nothing.
 */
export const ReplyStep = Schema.Union([
  Schema.TaggedStruct("Record", { number: Schema.Int }),
  Schema.TaggedStruct("Hold", { held: Schema.Array(LogEntry) }),
  Schema.TaggedStruct("Nothing", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ReplyStep = typeof ReplyStep.Type
