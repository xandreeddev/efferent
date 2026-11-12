import { Schema } from "effect"
import { Seq } from "./ids.entity.js"
import { Message } from "./message.entity.js"

/** A step's place in its turn, from 1: one model request and its answer. */
export const StepNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("StepNumber"))
export type StepNumber = typeof StepNumber.Type

/** A count of tokens: an estimate or a budget. */
export const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("Tokens"))
export type Tokens = typeof Tokens.Type

/**
 * What memory builds for one request: the messages to send, each the place
 * (`seq`) of a record of the journal that bears a message, never a copy; its
 * estimate of the request's cost, and the budget it kept to.
 */
export const ModelRequest = Schema.Struct({ messages: Schema.Array(Seq), estimatedTokens: Tokens, budgetTokens: Tokens })
export type ModelRequest = typeof ModelRequest.Type

/** A request as `plugin.loop.request.sent` stores it: the step, the system text, and what memory built. */
export const SentRequest = Schema.Struct({ step: StepNumber, system: Schema.String, ...ModelRequest.fields })
export type SentRequest = typeof SentRequest.Type

/** A pointer turned back into the message it points at. */
export const PointedMessage = Schema.Struct({ seq: Seq, message: Message })
export type PointedMessage = typeof PointedMessage.Type

/**
 * A request with its pointers turned back into messages: exactly what the model is sent.
 *
 * @public
 */
export const ResolvedRequest = Schema.Struct({
  system: Schema.String,
  messages: Schema.Array(PointedMessage),
  estimatedTokens: Tokens,
  budgetTokens: Tokens,
})
export type ResolvedRequest = typeof ResolvedRequest.Type

/**
 * A request that cannot be sent: it points at a place that holds no message
 * (`UnknownMessage`), at the same place twice (`RepeatedMessage`), or at a
 * place that is not before the request's own (`LaterMessage`).
 *
 * @public
 */
export class RequestRefused extends Schema.TaggedError<RequestRefused>()("RequestRefused", {
  reason: Schema.Literals(["UnknownMessage", "RepeatedMessage", "LaterMessage"]),
  seq: Seq,
  message: Schema.String,
}) {}

/**
 * A request the session sent, as a host inspects it (`requestsOf`): where
 * it is stored, its step, and what the model was sent, resolved.
 *
 * @public
 */
export const InspectedRequest = Schema.Struct({ seq: Seq, step: StepNumber, ...ResolvedRequest.fields })
export type InspectedRequest = typeof InspectedRequest.Type
