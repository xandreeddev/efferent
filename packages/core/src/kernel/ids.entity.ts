import { Schema } from "effect"

/** A session's id: plain data, kept by the host to come back to the session. */
export const SessionId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

/** Who a session belongs to. */
export const Owner = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("Owner"))
export type Owner = typeof Owner.Type

/** A turn's place in its session, from 1. */
export const TurnNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("TurnNumber"))
export type TurnNumber = typeof TurnNumber.Type

/** A stored event's place in its journal, from 1; 0 is the journal that holds none yet. */
export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("Seq"))
export type Seq = typeof Seq.Type

/**
 * A plugin's name, which is also the prefix of the events it writes: `plugin.<name>.`.
 *
 * @public
 */
export const PluginName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)).pipe(Schema.brand("PluginName"))
export type PluginName = typeof PluginName.Type

/**
 * An event's name, under the prefix of who writes it: `core.` or `plugin.<plugin name>.`.
 *
 * @public
 */
export const EventName = Schema.String.check(Schema.isPattern(/^(?:core|plugin\.[a-z0-9][a-z0-9-]*)(?:\.[a-z0-9][a-z0-9-]*)+$/)).pipe(Schema.brand("EventName"))
export type EventName = typeof EventName.Type

/**
 * The id a model gives one of its tool calls.
 *
 * @public
 */
export const ToolCallId = Schema.String.check(Schema.isNonEmpty()).pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type
