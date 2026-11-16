import type { Option, Schema } from "effect"
import type { AssistantMessageData, Seq, SessionId, StoredEvent, ToolCall, TurnEndedData, TurnNumber } from "@xandreed/core/kernel"

/**
 * A user's message as a journal holds it: its text, and the place of its record.
 *
 * @public
 */
export interface MessageRead {
  readonly seq: Seq
  readonly text: string
  /** The session that sent the message, when it was not the person: a background task's report (ADR 0018). */
  readonly from?: SessionId
}

/**
 * What a tool call came to: the result as stored, or, with `isFailure`, why it failed, and the place of its record.
 *
 * @public
 */
export interface ResultRead {
  readonly seq: Seq
  readonly result: Schema.Json
  readonly isFailure: boolean
}

/**
 * A tool call the model asked for, with its result when the journal holds one.
 *
 * @public
 */
export interface CallRead extends ToolCall {
  readonly result: Option.Option<ResultRead>
}

/**
 * One step of a turn: one answer of the model, as `conversation.assistant.message` stored it. Its text, the calls
 * it asked for, and what its writer knew of the call that made it (the model that answered, and its usage).
 *
 * @public
 */
export interface StepRead {
  readonly seq: Seq
  readonly text: string
  readonly calls: ReadonlyArray<CallRead>
  readonly model: Option.Option<NonNullable<AssistantMessageData["model"]>>
  readonly usage: Option.Option<NonNullable<AssistantMessageData["usage"]>>
}

/**
 * How a turn closed: its outcome, and the place of the record that closed it.
 *
 * @public
 */
export interface ClosedRead {
  readonly seq: Seq
  readonly outcome: TurnEndedData["outcome"]
}

/**
 * One turn as its journal tells it (`turnsOf`): what a test checks, and what a client draws. Every part names the
 * place of its record, `seq`, which orders a turn's messages against its steps.
 *
 * - `opened`: the place of `core.session.turn.started`; none for records that name a turn no record opened.
 * - `messages`: every message of the user's stored in the turn, in order: the ones it opened with, and any that
 *   joined it later.
 * - `steps`: one for each answer of the model, in order.
 * - `answer`: the last step's text, when that step asked for no tool: what the turn answered. None for a turn that
 *   ended on a call, or that has no step.
 * - `closed`: how the turn ended; none while it is open.
 * - `records`: every record stored in the turn, in order, whatever wrote it. A plugin's own records are read from
 *   here, with `dataOf` and the plugin's definition.
 *
 * @public
 */
export interface TurnRead {
  readonly turn: TurnNumber
  readonly opened: Option.Option<Seq>
  readonly messages: ReadonlyArray<MessageRead>
  readonly steps: ReadonlyArray<StepRead>
  readonly answer: Option.Option<string>
  readonly closed: Option.Option<ClosedRead>
  readonly records: ReadonlyArray<StoredEvent>
}
