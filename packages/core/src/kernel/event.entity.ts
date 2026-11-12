import { Schema } from "effect"
import { EventName, Seq, SessionId, StepNumber, TurnNumber } from "./ids.entity.js"
import { AssistantMessage, Reply } from "./message.entity.js"

/** An event before it is stored or published: its name and its data, as JSON. */
export const EventDraft = Schema.Struct({ name: EventName, data: Schema.Json })
export type EventDraft = typeof EventDraft.Type

/**
 * The names of the events the engine writes. `assistantDelta` is live only; the others are stored.
 *
 * @public
 */
export const CORE_EVENTS = {
  turnStarted: EventName.make("core.turn.started"),
  userMessage: EventName.make("core.user.message"),
  requestSent: EventName.make("core.request.sent"),
  assistantDelta: EventName.make("core.assistant.delta"),
  assistantMessage: EventName.make("core.assistant.message"),
  turnEnded: EventName.make("core.turn.ended"),
}

/** The data of `core.assistant.message`: the step's answer. */
export const AssistantMessageData = Schema.Struct({ step: StepNumber, message: AssistantMessage })
export type AssistantMessageData = typeof AssistantMessageData.Type

/**
 * How a turn ended: with its reply, with the reason it failed, or interrupted.
 *
 * @public
 */
export const TurnOutcome = Schema.Union([
  Schema.TaggedStruct("Completed", { reply: Reply }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
  Schema.TaggedStruct("Interrupted", {}),
])
export type TurnOutcome = typeof TurnOutcome.Type

/** An event on the live stream, with its session and turn: `Recorded` when the journal holds it, `Emitted` when nothing does. */
export const LiveEvent = Schema.Union([
  Schema.TaggedStruct("Recorded", { session: SessionId, turn: TurnNumber, seq: Seq, at: Schema.Number, name: EventName, data: Schema.Json }),
  Schema.TaggedStruct("Emitted", { session: SessionId, turn: TurnNumber, name: EventName, data: Schema.Json }),
])
export type LiveEvent = typeof LiveEvent.Type
