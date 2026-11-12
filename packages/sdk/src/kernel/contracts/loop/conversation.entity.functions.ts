import { live, stored } from "@xandreed/core/kernel"
import type { AssistantMessage, LiveEvent, SessionId, StoredDraft, TurnNumber } from "@xandreed/core/kernel"
import type { ModelRequest, StepNumber } from "./request.entity.js"
import { assistantDeltaEvent, assistantMessageEvent, requestSentEvent, userMessageEvent } from "./conversation.entity.js"

/**
 * `plugin.loop.user.message`: the user's text, as the message the record bears.
 *
 * @public
 */
export const userMessage = (text: string): StoredDraft => stored(userMessageEvent, {}, { message: { _tag: "User", text } })

/**
 * `plugin.loop.request.sent`: the step, the system text, and the request memory built, its messages still pointers.
 *
 * @public
 */
export const requestSent = (step: StepNumber, system: string, request: ModelRequest): StoredDraft =>
  stored(requestSentEvent, { step, system, messages: request.messages, estimatedTokens: request.estimatedTokens, budgetTokens: request.budgetTokens })

/**
 * `plugin.loop.assistant.message`: the model's answer in this step, as the message the record bears.
 *
 * @public
 */
export const assistantMessage = (step: StepNumber, message: AssistantMessage): StoredDraft => stored(assistantMessageEvent, { step }, { message })

/**
 * `plugin.loop.assistant.delta`: a piece of the answer, for the session's open turn.
 *
 * @public
 */
export const assistantDelta = (session: { readonly id: SessionId; readonly turn: TurnNumber }, delta: string): LiveEvent =>
  live(assistantDeltaEvent, session, { text: delta })
