import { Context } from "effect"
import type { Effect } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"
import type { MemoryReader } from "./memory.port.js"
import type { TurnEventsService, TurnTasksService } from "./turn-events.port.js"

/** The current run, as tools, sections and run layers see it. Provided by the turn. */
export class RunContext extends Context.Tag("efferent/RunContext")<RunContext, {
  readonly conversation: ConversationId
  readonly runId: string
  readonly userMessage: UserMessage
  readonly memory: MemoryReader
  readonly events: TurnEventsService
  readonly tasks: TurnTasksService
  /** Host-initiated skill activation (e.g. a handler that needs another skill next step). */
  readonly activate: (skills: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, HarnessError>
  /** Wait until every journal write queued so far is stored (before an externally visible action). */
  readonly flush: Effect.Effect<void, HarnessError>
  /** Run a host store write in journal order (after everything queued before it). */
  readonly write: <A, E>(op: Effect.Effect<A, E>) => Effect.Effect<A, E | HarnessError>
}>() {}
