import { Context } from "effect"
import type { Effect } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { RunId } from "../domain/run.entity.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import type { AdmittedTurn, SessionAddress, TurnError } from "../session/sessions.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"
import type { MemoryReader } from "./memory.port.js"
import type { TurnEventsService, TurnTasksService } from "./turn-events.port.js"

/** The current run, as tools, sections and run layers see it. Provided by the turn. */
export class RunContext extends Context.Service<RunContext, {
  readonly conversation: ConversationId
  /** The session the turn runs in, as its owner names it. */
  readonly session: SessionAddress
  readonly runId: RunId
  readonly userMessage: UserMessage
  /** The admitted turn as the session began it: its number, key, origin, command, claimed inbox items and the host's `meta`. */
  readonly admitted: AdmittedTurn
  readonly memory: MemoryReader
  readonly events: TurnEventsService
  readonly tasks: TurnTasksService
  /** Host-initiated skill activation (e.g. a handler that needs another skill next step). */
  readonly activate: (skills: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, TurnError>
  /** Wait until every journal write queued so far is stored (before an externally visible action). */
  readonly flush: Effect.Effect<void, TurnError>
  /** Run a host store write in journal order (after everything queued before it). */
  readonly write: <A, E>(op: Effect.Effect<A, E>) => Effect.Effect<A, E | TurnError>
  /** The turn's usage so far: the usage of every `assistant.message` published in the turn, summed. */
  readonly usage: Effect.Effect<TokenUsage>
}>()("efferent/RunContext") {}
