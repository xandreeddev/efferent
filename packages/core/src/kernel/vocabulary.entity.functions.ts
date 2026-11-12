import { Cause, Exit } from "effect"
import { live, originOf, reasonOf, stored } from "./event.entity.functions.js"
import type { KernelEvent, ListenerFailed, LiveEvent, StoredDraft } from "./event.entity.js"
import type { TurnNumber } from "./ids.entity.js"
import { listenerFailedEvent, turnEndedEvent, turnStartedEvent } from "./vocabulary.entity.js"
import type { TurnOutcome } from "./vocabulary.entity.js"

/** `core.session.turn.started`, for the turn that opened. */
export const turnStarted = (turn: TurnNumber): StoredDraft => stored(turnStartedEvent, { turn })

/** How a turn that exited this way ended. */
export const outcomeOf = (exit: Exit.Exit<unknown, unknown>): TurnOutcome =>
  Exit.match(exit, {
    onSuccess: (): TurnOutcome => ({ _tag: "Completed" }),
    onFailure: (cause): TurnOutcome => Cause.hasInterruptsOnly(cause) ? { _tag: "Interrupted" } : { _tag: "Failed", reason: reasonOf(cause) },
  })

/** `core.session.turn.ended`, for the turn that closed and how. */
export const turnEnded = (turn: TurnNumber, outcome: TurnOutcome): StoredDraft => stored(turnEndedEvent, { turn, outcome })

/** `core.listener.failed`: the listener that failed, about the event it failed on. */
export const listenerFailed = (event: KernelEvent, failure: ListenerFailed): LiveEvent =>
  live(listenerFailedEvent, originOf(event), { listener: failure.listener, event: failure.event, reason: failure.message })
