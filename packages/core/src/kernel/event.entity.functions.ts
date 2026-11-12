import { Cause, Exit, Option, Predicate } from "effect"
import type { TurnInput } from "./agent.entity.js"
import { CORE_EVENTS } from "./event.entity.js"
import type { EventDraft, LiveEvent, TurnOutcome } from "./event.entity.js"
import type { StepNumber } from "./ids.entity.js"
import type { StoredEvent } from "./journal.entity.js"
import type { AssistantMessage, Reply } from "./message.entity.js"
import type { ModelRequest } from "./request.entity.js"
import type { OpenSession } from "./sessions.port.js"

/** `core.turn.started`: a turn began on the session. */
export const turnStarted = (input: TurnInput): EventDraft => ({ name: CORE_EVENTS.turnStarted, data: { session: input.session } })

/** `core.user.message`: what the user sent. */
export const userMessage = (text: string): EventDraft => ({ name: CORE_EVENTS.userMessage, data: { _tag: "User", text } })

/** `core.request.sent`: what the model is sent in this step, its messages as their places in the journal. */
export const requestSent = (step: StepNumber, request: ModelRequest): EventDraft => ({
  name: CORE_EVENTS.requestSent,
  data: {
    step,
    system: request.system,
    messages: request.messages.map((sent) => sent.seq),
    estimatedTokens: request.estimatedTokens,
    budgetTokens: request.budgetTokens,
  },
})

/** `core.assistant.delta`: a piece of the answer as it arrives. Live only. */
export const assistantDelta = (delta: string): EventDraft => ({ name: CORE_EVENTS.assistantDelta, data: { text: delta } })

/** `core.assistant.message`: the model's whole answer in this step. */
export const assistantMessage = (step: StepNumber, message: AssistantMessage): EventDraft => ({ name: CORE_EVENTS.assistantMessage, data: { step, message } })

/** A failure as the journal words it: its tag, then its message. */
const reasonOf = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "defect",
    onSome: (error) => [
      ...(Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? [error._tag] : []),
      ...(Predicate.hasProperty(error, "message") && Predicate.isString(error.message) ? [error.message] : []),
    ].join(": "),
  })

/** How a turn that exited this way ended. */
export const outcomeOf = <E>(exit: Exit.Exit<Reply, E>): TurnOutcome =>
  Exit.match(exit, {
    onSuccess: (reply): TurnOutcome => ({ _tag: "Completed", reply }),
    onFailure: (cause): TurnOutcome => Cause.hasInterruptsOnly(cause) ? { _tag: "Interrupted" } : { _tag: "Failed", reason: reasonOf(cause) },
  })

/** `core.turn.ended`: the turn is over, with its outcome. */
export const turnEnded = (outcome: TurnOutcome): EventDraft => ({ name: CORE_EVENTS.turnEnded, data: { outcome } })

/** A stored event as the live stream carries it. */
export const recordedEvent = (session: OpenSession, stored: StoredEvent): LiveEvent => ({ _tag: "Recorded", session: session.id, turn: session.turn, ...stored })

/** An event nothing stores, as the live stream carries it. */
export const liveEvent = (session: OpenSession, event: EventDraft): LiveEvent => ({ _tag: "Emitted", session: session.id, turn: session.turn, ...event })
