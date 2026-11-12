import { Schema } from "effect"
import { liveEvent, storedEvent } from "./event.entity.functions.js"
import type { LiveDefinition } from "./event.entity.js"
import { EventName, StepNumber, TurnNumber } from "./ids.entity.js"
import type { Reader } from "./journal.entity.js"
import { SentRequest } from "./request.entity.js"

/*
 * The facts other plugins rely on, whichever plugin writes them: a second
 * session plugin or loop plugin writes these same names. A plugin's own
 * events are defined in its own folder, with the same two helpers.
 */

/**
 * The data of `plugin.session.turn.started`: the turn that opened.
 *
 * @public
 */
export const TurnStartedData = Schema.Struct({ turn: TurnNumber })
export type TurnStartedData = typeof TurnStartedData.Type

/** `plugin.session.turn.started`: a turn opened on the session. Stored. */
export const turnStartedEvent = storedEvent("session", "turn.started", { data: TurnStartedData, skippable: false })

/**
 * How a turn ended: completed, failed with the reason, or interrupted. The reply is not here: its text is the assistant message's.
 *
 * @public
 */
export const TurnOutcome = Schema.Union([
  Schema.TaggedStruct("Completed", {}),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
  Schema.TaggedStruct("Interrupted", {}),
])
export type TurnOutcome = typeof TurnOutcome.Type

/**
 * The data of `plugin.session.turn.ended`: the turn that closed, and how.
 *
 * @public
 */
export const TurnEndedData = Schema.Struct({ turn: TurnNumber, outcome: TurnOutcome })
export type TurnEndedData = typeof TurnEndedData.Type

/** `plugin.session.turn.ended`: the turn closed, with its outcome. Stored. */
export const turnEndedEvent = storedEvent("session", "turn.ended", { data: TurnEndedData, skippable: false })

/** `plugin.loop.user.message`: what the user sent. Stored; the message is on the envelope. */
export const userMessageEvent = storedEvent("loop", "user.message", { data: Schema.Struct({}), skippable: false })

/** `plugin.loop.request.sent`: what the model is sent in a step, its messages as places in the journal. Stored. */
export const requestSentEvent = storedEvent("loop", "request.sent", { data: SentRequest, skippable: false })

/**
 * The data of `plugin.loop.assistant.message`: the step it answers.
 *
 * @public
 */
export const AssistantMessageData = Schema.Struct({ step: StepNumber })
export type AssistantMessageData = typeof AssistantMessageData.Type

/** `plugin.loop.assistant.message`: the model's whole answer in a step. Stored; the message is on the envelope. */
export const assistantMessageEvent = storedEvent("loop", "assistant.message", { data: AssistantMessageData, skippable: false })

/**
 * The data of `plugin.loop.assistant.delta`: a piece of the answer.
 *
 * @public
 */
export const AssistantDeltaData = Schema.Struct({ text: Schema.String })
export type AssistantDeltaData = typeof AssistantDeltaData.Type

/** `plugin.loop.assistant.delta`: a piece of the answer as it arrives. Live only. */
export const assistantDeltaEvent = liveEvent("loop", "assistant.delta", { data: AssistantDeltaData })

/**
 * The data of `core.listener.failed`: which listener, on which event, and why.
 *
 * @public
 */
export const ListenerFailedData = Schema.Struct({ listener: Schema.String, event: EventName, reason: Schema.String })
export type ListenerFailedData = typeof ListenerFailedData.Type

/** `core.listener.failed`: a listener failed where nothing could fail for it. Live only; the one event core itself writes. */
export const listenerFailedEvent: LiveDefinition<ListenerFailedData> = {
  kind: "live",
  name: EventName.make("core.listener.failed"),
  data: ListenerFailedData,
}

/**
 * What every reader of a journal answers for: the records of the session
 * and loop plugins. A plugin's reader adds its own prefix (`readerFor`).
 *
 * @public
 */
export const KERNEL_READER: Reader = {
  reads: ["plugin.session.", "plugin.loop."],
  knows: [turnStartedEvent.name, turnEndedEvent.name, userMessageEvent.name, requestSentEvent.name, assistantMessageEvent.name],
}
