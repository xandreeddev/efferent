import { Schema } from "effect"
import { StoredEvent } from "./event.entity.js"
import { Seq, StepNumber, Tokens } from "./ids.entity.js"
import { Message } from "./message.entity.js"
import { SessionHeader, SessionState } from "./session.entity.js"

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

/** A request with its pointers turned back into messages: exactly what the model is sent. */
export const ResolvedRequest = Schema.Struct({
  system: Schema.String,
  messages: Schema.Array(Schema.Struct({ seq: Seq, message: Message })),
  estimatedTokens: Tokens,
  budgetTokens: Tokens,
})
export type ResolvedRequest = typeof ResolvedRequest.Type

/**
 * A request that cannot be sent: it points at a place that holds no message
 * (`UnknownMessage`), or at the same place twice (`RepeatedMessage`).
 */
export class RequestRefused extends Schema.TaggedError<RequestRefused>()("RequestRefused", {
  reason: Schema.Literals(["UnknownMessage", "RepeatedMessage"]),
  seq: Seq,
  message: Schema.String,
}) {}

/** A session as a host inspects it: its header, its state, its journal, and every request it sent, resolved. */
export const Inspection = Schema.Struct({
  header: SessionHeader,
  state: SessionState,
  events: Schema.Array(StoredEvent),
  requests: Schema.Array(Schema.Struct({ seq: Seq, step: StepNumber, ...ResolvedRequest.fields })),
})
export type Inspection = typeof Inspection.Type
