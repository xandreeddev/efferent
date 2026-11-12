import { Array as Arr, Effect, Option } from "effect"
import type { Agent } from "./agent.entity.js"
import { CORE_EVENTS } from "./event.entity.js"
import type { EventDraft } from "./event.entity.js"
import { Tokens } from "./ids.entity.js"
import { messageOf } from "./journal.entity.functions.js"
import { RequestRefused } from "./request.entity.js"
import type { BuiltContext, ModelRequest } from "./request.entity.js"
import type { OpenSession } from "./sessions.port.js"

/** A rough count of the tokens a text costs: a quarter of its characters. */
const estimate = (text: string): number => Math.ceil(text.length / 4)

/** The records a context manager wrote while it built, which the engine stores before the request. */
export const writtenBy = (built: BuiltContext): ReadonlyArray<EventDraft> => built.records

/**
 * The request a built context makes, checked: every place it points at
 * holds a message of the journal, the message this turn answers is among
 * them, and the estimate of the system text and the messages fits the
 * agent's budget. Anything else is a `RequestRefused`.
 */
export const checkRequest = Effect.fnUntraced(function* (agent: Agent, session: OpenSession, built: BuiltContext) {
  const journal = yield* session.journal
  const stored = new Map(journal.map((event) => [event.seq, event] as const))
  const pointed = built.messages.map((seq) =>
    Option.fromNullishOr(stored.get(seq)).pipe(Option.flatMap(messageOf), Option.map((message) => ({ seq, message }))))
  const messages = Arr.getSomes(pointed)
  const estimatedTokens = Tokens.make(estimate(agent.system) + messages.reduce((sum, sent) => sum + estimate(sent.message.text), 0))
  const budgetTokens = agent.limits.budgetTokens
  const refuse = (reason: RequestRefused["reason"], message: string) =>
    Effect.fail(new RequestRefused({ reason, estimatedTokens, budgetTokens, message }))
  if (messages.length < pointed.length) return yield* refuse("UnknownMessage", "the built context points at an event that is no message of the journal")
  const asked = Arr.findLast(journal, (event) => event.name === CORE_EVENTS.userMessage)
  if (!Option.exists(asked, (event) => built.messages.includes(event.seq))) {
    return yield* refuse("TurnMessageMissing", "the built context leaves out the message this turn answers")
  }
  if (estimatedTokens > budgetTokens) {
    return yield* refuse("OverBudget", `the request is estimated at ${estimatedTokens} tokens, over the budget of ${budgetTokens}`)
  }
  const request: ModelRequest = { system: agent.system, messages, estimatedTokens, budgetTokens }
  return request
})
