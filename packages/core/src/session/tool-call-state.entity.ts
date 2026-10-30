import { Schema } from "effect"
import { ConversationId, ToolCallId } from "../domain/message.entity.js"
import { InvocationId, RunId, RunOrdinal } from "../domain/run.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"
import { ToolRefusalReason } from "../turn/turn-event.entity.js"

const request = {
  session: ConversationId,
  turn: Schema.Int,
  runId: RunId,
  run: RunOrdinal,
  step: Schema.Int,
  toolCallId: ToolCallId,
  tool: Schema.String,
  /** The encoded parameters in the assistant's durable call. */
  input: Schema.Unknown,
  request: EntryId,
  requestedSeq: Schema.Int,
}

/** The durable evidence that the registry admitted a call to its handler. */
export const ToolCallStart = Schema.Struct({ invocationId: InvocationId, seq: Schema.Int, input: Schema.Unknown })
export type ToolCallStart = typeof ToolCallStart.Type

/** The durable evidence that a handler returned; its result may not yet be recorded. */
export const ToolCallReturn = Schema.Struct({ invocationId: InvocationId, seq: Schema.Int, ok: Schema.Boolean })
export type ToolCallReturn = typeof ToolCallReturn.Type

/** A settled result as stored in memory, including a refused call's failed result. */
export const ToolCallResult = Schema.Struct({ entry: EntryId, seq: Schema.Int, encoded: Schema.Unknown, isError: Schema.Boolean })
export type ToolCallResult = typeof ToolCallResult.Type

/**
 * What the journal proves about one requested tool call. Requested means no
 * correlated start is recorded; Started does not promise the handler made no
 * side effects. Returned means the registry recorded its exit but memory has
 * no result. Completed has the durable encoded result. Refused never ran the
 * handler and keeps its result when memory recorded it.
 *
 * @public
 */
export const ToolCallState = Schema.Union([
  Schema.TaggedStruct("Requested", request),
  Schema.TaggedStruct("Started", { ...request, started: ToolCallStart }),
  Schema.TaggedStruct("Returned", { ...request, started: Schema.OptionFromNullOr(ToolCallStart), returned: ToolCallReturn }),
  Schema.TaggedStruct("Completed", { ...request, started: Schema.OptionFromNullOr(ToolCallStart), returned: Schema.OptionFromNullOr(ToolCallReturn), result: ToolCallResult }),
  Schema.TaggedStruct("Refused", { ...request, invocationId: InvocationId, refusedSeq: Schema.Int, reason: ToolRefusalReason, message: Schema.String, result: Schema.OptionFromNullOr(ToolCallResult) }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ToolCallState = typeof ToolCallState.Type
