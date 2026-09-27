import { Context } from "effect"
import type { Effect } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { MemoryReader } from "./memory.port.js"
import type { TurnEventsService, TurnTasksService } from "./turn-events.port.js"

/** The current run, as tools, sections and run layers see it. Provided by the turn. */
export class RunContext extends Context.Tag("efferent/RunContext")<RunContext, {
  readonly conversation: ConversationId
  readonly runId: string
  readonly prompt: string
  readonly memory: MemoryReader
  readonly events: TurnEventsService
  readonly tasks: TurnTasksService
  /** Host-initiated skill activation (e.g. a handler that needs another skill next step). */
  readonly activate: (skills: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, HarnessError>
}>() {}
