import { Array as Arr, Option, Result } from "effect"
import { dataOf } from "@xandreed/core/kernel"
import type { Message, Seq, StoredEvent } from "@xandreed/core/kernel"
import { RequestRefused, StepNumber, Tokens } from "./request.entity.js"
import type { InspectedRequest, PointedMessage } from "./request.entity.js"
import { requestSentEvent, userMessageEvent } from "./conversation.entity.js"

/**
 * The step every turn starts with.
 *
 * @public
 */
export const firstStep: StepNumber = StepNumber.make(1)

/**
 * The estimate of what a text costs, in tokens: a quarter of its
 * characters, rounded up. An approximation, and the only one: memory, the
 * kits and every reader count with this function.
 *
 * @public
 */
export const estimateTokens = (text: string): Tokens => Tokens.make(Math.ceil(text.length / 4))

/** The estimate of a whole request: its system text and each of its messages. */
export const estimateRequest = (system: string, messages: ReadonlyArray<Message>): Tokens =>
  Tokens.make(messages.reduce<number>((sum, message) => sum + estimateTokens(message.text), estimateTokens(system)))

/**
 * A request's pointers turned back into the messages they point at, in the
 * request's order: exactly what the model is sent, for the model call and
 * for a reader alike. Each pointer names an earlier record that bears a
 * message: a place that holds none, the same place twice, or a place at or
 * after `before` (the place of the stored request itself, when it has one)
 * refuses the request.
 *
 * @public
 */
export const resolveRequest = (journal: ReadonlyArray<StoredEvent>, request: { readonly messages: ReadonlyArray<Seq> }, before?: Seq): Result.Result<ReadonlyArray<PointedMessage>, RequestRefused> => {
  const stored = new Map(journal.map((event) => [event.seq, event] as const))
  const seen = new Set<Seq>()
  const messages: Array<PointedMessage> = []
  for (const seq of request.messages) {
    if (seen.has(seq)) return Result.fail(new RequestRefused({ reason: "RepeatedMessage", seq, message: `the request points at ${seq} twice` }))
    seen.add(seq)
    if (before !== undefined && seq >= before) return Result.fail(new RequestRefused({ reason: "LaterMessage", seq, message: `the request at ${before} points at ${seq}, which is not before it` }))
    const message = stored.get(seq)?.message
    if (message === undefined) return Result.fail(new RequestRefused({ reason: "UnknownMessage", seq, message: `the request points at ${seq}, which holds no message` }))
    messages.push({ seq, message })
  }
  return Result.succeed(messages)
}

/** The place of the message the journal's latest turn answers: its last `plugin.loop.user.message`. */
export const turnMessageOf = (journal: ReadonlyArray<StoredEvent>): Option.Option<Seq> =>
  Option.map(Arr.findLast(journal, (event) => event.name === userMessageEvent.name), (event) => event.seq)

/**
 * Every request a journal says was sent, each with its pointers resolved:
 * what the model was sent, request by request. A stored request that
 * points at no message, or at one stored after it, refuses the journal.
 */
export const requestsOf = (journal: ReadonlyArray<StoredEvent>): Result.Result<ReadonlyArray<InspectedRequest>, RequestRefused> => {
  const requests: Array<InspectedRequest> = []
  for (const event of journal) {
    const sent = dataOf(requestSentEvent, event)
    if (Option.isNone(sent)) continue
    const messages = resolveRequest(journal, sent.value, event.seq)
    if (Result.isFailure(messages)) return Result.fail(messages.failure)
    requests.push({ seq: event.seq, step: sent.value.step, system: sent.value.system, messages: messages.success, estimatedTokens: sent.value.estimatedTokens, budgetTokens: sent.value.budgetTokens })
  }
  return Result.succeed(requests)
}
