import { Cause, Exit } from "effect"
import { live, originOf, reasonOf, stored } from "./event.entity.functions.js"
import type { KernelEvent, ListenerFailed, LiveEvent, StoredDraft } from "./event.entity.js"
import type { SessionId, StepNumber, TurnNumber } from "./ids.entity.js"
import type { AssistantMessage } from "./message.entity.js"
import type { ModelRequest } from "./request.entity.js"
import {
  assistantDeltaEvent,
  assistantMessageEvent,
  listenerFailedEvent,
  requestSentEvent,
  turnEndedEvent,
  turnStartedEvent,
  userMessageEvent,
} from "./vocabulary.entity.js"
import type { TurnOutcome } from "./vocabulary.entity.js"

/** `plugin.session.turn.started`, for the turn that opened. */
export const turnStarted = (turn: TurnNumber): StoredDraft => stored(turnStartedEvent, { turn })

/** How a turn that exited this way ended. */
export const outcomeOf = (exit: Exit.Exit<unknown, unknown>): TurnOutcome =>
  Exit.match(exit, {
    onSuccess: (): TurnOutcome => ({ _tag: "Completed" }),
    onFailure: (cause): TurnOutcome => Cause.hasInterruptsOnly(cause) ? { _tag: "Interrupted" } : { _tag: "Failed", reason: reasonOf(cause) },
  })

/** `plugin.session.turn.ended`, for the turn that closed and how. */
export const turnEnded = (turn: TurnNumber, outcome: TurnOutcome): StoredDraft => stored(turnEndedEvent, { turn, outcome })

/** `plugin.loop.user.message`: the user's text, as the message the record bears. */
export const userMessage = (text: string): StoredDraft => stored(userMessageEvent, {}, { message: { _tag: "User", text } })

/** `plugin.loop.request.sent`: the step, the system text, and the request memory built, its messages still pointers. */
export const requestSent = (step: StepNumber, system: string, request: ModelRequest): StoredDraft =>
  stored(requestSentEvent, { step, system, messages: request.messages, estimatedTokens: request.estimatedTokens, budgetTokens: request.budgetTokens })

/** `plugin.loop.assistant.message`: the model's answer in this step, as the message the record bears. */
export const assistantMessage = (step: StepNumber, message: AssistantMessage): StoredDraft => stored(assistantMessageEvent, { step }, { message })

/** `plugin.loop.assistant.delta`: a piece of the answer, for the session's open turn. */
export const assistantDelta = (session: { readonly id: SessionId; readonly turn: TurnNumber }, delta: string): LiveEvent =>
  live(assistantDeltaEvent, session, { text: delta })

/** `core.listener.failed`: the listener that failed, about the event it failed on. */
export const listenerFailed = (event: KernelEvent, failure: ListenerFailed): LiveEvent =>
  live(listenerFailedEvent, originOf(event), { listener: failure.listener, event: failure.event, reason: failure.message })
