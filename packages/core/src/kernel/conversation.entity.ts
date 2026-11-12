import { Schema } from "effect"
import { liveEvent, storedEvent } from "./event.entity.functions.js"
import type { Reader } from "./journal.entity.js"
import { readerFor } from "./journal.entity.functions.js"
import { SentRequest, StepNumber } from "./request.entity.js"

/*
 * The conversation's events, which the loop contract defines: a second loop
 * plugin writes these same names, and a memory reads them. A plugin's own
 * events are defined in its own folder, with the same two helpers.
 */

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
 * The reader of the loop's records: core's records and the conversation's.
 * A memory reads with a reader that extends it (`readerFor(name, own, LOOP_READER)`).
 *
 * @public
 */
export const LOOP_READER: Reader = readerFor("loop", [userMessageEvent, requestSentEvent, assistantMessageEvent])
