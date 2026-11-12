import { Schema } from "effect"
import { EventDraft } from "./event.entity.js"
import { Seq, StepNumber, Tokens } from "./ids.entity.js"
import { Message } from "./message.entity.js"

/**
 * What an agent may spend on one request.
 *
 * @public
 */
export const Limits = Schema.Struct({ budgetTokens: Tokens })
export type Limits = typeof Limits.Type

/**
 * What a context manager is asked to build a request's context for.
 *
 * @public
 */
export const BuildInput = Schema.Struct({ step: StepNumber, limits: Limits })
export type BuildInput = typeof BuildInput.Type

/**
 * What a context manager built for one request: the messages to send, each
 * the place (`seq`) of a message the journal already holds, and the
 * manager's own records, which the engine stores beside the request.
 *
 * @public
 */
export const BuiltContext = Schema.Struct({ messages: Schema.Array(Seq), records: Schema.Array(EventDraft) })
export type BuiltContext = typeof BuiltContext.Type

/** A request the engine checked: what the model is sent, each message with its place in the journal. */
export const ModelRequest = Schema.Struct({
  system: Schema.String,
  messages: Schema.Array(Schema.Struct({ seq: Seq, message: Message })),
  estimatedTokens: Tokens,
  budgetTokens: Tokens,
})
export type ModelRequest = typeof ModelRequest.Type

/** A context manager could not read what it builds from (`OpenFailed`) or build a request's context (`BuildFailed`). */
export class ContextError extends Schema.TaggedError<ContextError>()("ContextError", {
  reason: Schema.Literals(["OpenFailed", "BuildFailed"]),
  message: Schema.String,
}) {}

/**
 * A built context the engine does not send: it points at an event that is no
 * message (`UnknownMessage`), leaves out the message the turn answers
 * (`TurnMessageMissing`), or its estimate is over the budget (`OverBudget`).
 *
 * @public
 */
export class RequestRefused extends Schema.TaggedError<RequestRefused>()("RequestRefused", {
  reason: Schema.Literals(["UnknownMessage", "TurnMessageMissing", "OverBudget"]),
  estimatedTokens: Tokens,
  budgetTokens: Tokens,
  message: Schema.String,
}) {}
