import { Schema } from "effect"

/** A session's id: plain data, kept by the host to come back to the session. */
export const SessionId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

/**
 * Who a session belongs to.
 *
 * @public
 */
export const Owner = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("Owner"))
export type Owner = typeof Owner.Type

/**
 * A turn's place in its session, from 1.
 *
 * @public
 */
export const TurnNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("TurnNumber"))
export type TurnNumber = typeof TurnNumber.Type

/** A step's place in its turn, from 1: one model request and its answer. */
export const StepNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("StepNumber"))
export type StepNumber = typeof StepNumber.Type

/** A stored event's place in its journal, from 1; 0 is the journal that holds none yet. */
export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("Seq"))
export type Seq = typeof Seq.Type

/** A count of tokens: an estimate, a budget or a usage. */
export const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("Tokens"))
export type Tokens = typeof Tokens.Type

/**
 * An event's name, under the prefix of who writes it: `core.` or `plugin.<kind>.`.
 *
 * @public
 */
export const EventName = Schema.String.check(Schema.isPattern(/^(?:core|plugin)(?:\.[a-z0-9][a-z0-9-]*)+$/)).pipe(Schema.brand("EventName"))
export type EventName = typeof EventName.Type

/**
 * The id a model gives one of its tool calls.
 *
 * @public
 */
export const ToolCallId = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type
