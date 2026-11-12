import { Array as Arr, Option, Result } from "effect"
import { dataOf } from "./event.entity.functions.js"
import type { StoredEvent } from "./event.entity.js"
import { Tokens } from "./ids.entity.js"
import type { Seq } from "./ids.entity.js"
import type { Journal, UnknownRecord } from "./journal.entity.js"
import type { Message } from "./message.entity.js"
import { RequestRefused } from "./request.entity.js"
import type { Inspection, ResolvedRequest } from "./request.entity.js"
import { sessionStateOf } from "./session.entity.functions.js"
import type { SessionRefused } from "./session.entity.js"
import { requestSentEvent, userMessageEvent } from "./vocabulary.entity.js"

/**
 * The estimate of what a text costs, in tokens: a quarter of its
 * characters, rounded up. An approximation, and the only one: memory, the
 * kits and every reader count with this function.
 */
export const estimateTokens = (text: string): Tokens => Tokens.make(Math.ceil(text.length / 4))

/** The estimate of a whole request: its system text and each of its messages. */
export const estimateRequest = (system: string, messages: ReadonlyArray<Message>): Tokens =>
  Tokens.make(messages.reduce<number>((sum, message) => sum + estimateTokens(message.text), estimateTokens(system)))

/** What `resolveRequest` reads of a request: the system text, the pointers and the two counts. A stored `SentRequest` is one. */
interface Pointed {
  readonly system: string
  readonly messages: ReadonlyArray<Seq>
  readonly estimatedTokens: Tokens
  readonly budgetTokens: Tokens
}

/**
 * A request's pointers turned back into the messages they point at, in the
 * request's order: exactly what the model is sent, for the model call and
 * for a reader alike. A pointer at a place that holds no message, or the
 * same place twice, refuses the request.
 */
export const resolveRequest = (journal: ReadonlyArray<StoredEvent>, request: Pointed): Result.Result<ResolvedRequest, RequestRefused> => {
  const stored = new Map(journal.map((event) => [event.seq, event] as const))
  const seen = new Set<Seq>()
  const messages: Array<{ readonly seq: Seq; readonly message: Message }> = []
  for (const seq of request.messages) {
    if (seen.has(seq)) return Result.fail(new RequestRefused({ reason: "RepeatedMessage", seq, message: `the request points at ${seq} twice` }))
    seen.add(seq)
    const message = stored.get(seq)?.message
    if (message === undefined) return Result.fail(new RequestRefused({ reason: "UnknownMessage", seq, message: `the request points at ${seq}, which holds no message` }))
    messages.push({ seq, message })
  }
  return Result.succeed({ system: request.system, messages, estimatedTokens: request.estimatedTokens, budgetTokens: request.budgetTokens })
}

/** The place of the message the journal's latest turn answers: its last `plugin.loop.user.message`. */
export const turnMessageOf = (journal: ReadonlyArray<StoredEvent>): Option.Option<Seq> =>
  Option.map(Arr.findLast(journal, (event) => event.name === userMessageEvent.name), (event) => event.seq)

/**
 * A session as a host inspects it: the state its journal folds to, and
 * every request it sent with its pointers resolved.
 */
export const inspectionOf = (journal: Journal): Result.Result<Inspection, UnknownRecord | SessionRefused | RequestRefused> => {
  const state = sessionStateOf(journal.events)
  if (Result.isFailure(state)) return Result.fail(state.failure)
  const requests: Array<Inspection["requests"][number]> = []
  for (const event of journal.events) {
    const sent = dataOf(requestSentEvent, event)
    if (Option.isNone(sent)) continue
    const resolved = resolveRequest(journal.events, sent.value)
    if (Result.isFailure(resolved)) return Result.fail(resolved.failure)
    requests.push({ seq: event.seq, step: sent.value.step, ...resolved.success })
  }
  return Result.succeed({ header: journal.header, state: state.success, events: journal.events, requests })
}
