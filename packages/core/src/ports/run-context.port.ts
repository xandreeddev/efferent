import { Context } from "effect"
import type { Effect } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { EventBody } from "../harness/session.entity.js"
import type { MemoryReader } from "./memory.port.js"

/** The current run, as tools, hooks and matchers see it. Provided by the agent loop per run. */
export class RunContext extends Context.Tag("efferent/RunContext")<RunContext, {
  readonly conversation: ConversationId
  readonly runId: string
  readonly prompt: string
  readonly publish: (event: EventBody) => Effect.Effect<void, HarnessError>
  readonly memory: MemoryReader
  /** Host-initiated skill activation (e.g. a handler that needs another skill next step). */
  readonly activate: (skills: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, HarnessError>
}>() {}
