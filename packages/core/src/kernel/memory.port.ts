import { Context } from "effect"
import type { Effect } from "effect"
import type { ListenerFailed, PluginFailure } from "./event.entity.js"
import type { StepNumber } from "./ids.entity.js"
import type { StorageError, UnknownRecord } from "./journal.entity.js"
import type { ModelRequest } from "./request.entity.js"
import type { OpenSession } from "./sessions.port.js"

/**
 * What memory can fail with: storage, a record it may not skip, a waiting listener, or an error of its own (over budget is one).
 *
 * @public
 */
export type MemoryFailure = StorageError | UnknownRecord | ListenerFailed | PluginFailure

/**
 * A turn's memory, opened once: it builds what each request of the turn sends.
 *
 * @public
 */
export interface OpenMemory {
  /**
   * The request of this step: pointers at the records of the journal whose
   * messages the model is sent, with the estimate and the budget. Text
   * memory writes for the model itself is appended to the open session
   * first, as memory's own record bearing a message, and pointed at.
   */
  readonly build: (step: StepNumber) => Effect.Effect<ModelRequest, MemoryFailure>
}

/**
 * What decides what the model is sent, and owns the budget. It reads the
 * session's journal and its own records and writes only through the open
 * session it is given. `memoryConformance` is the contract as runnable checks.
 */
export class Memory extends Context.Service<Memory, {
  /** Open the memory of the session's open turn. */
  readonly open: (session: OpenSession) => Effect.Effect<OpenMemory, MemoryFailure>
}>()("@xandreed/core/kernel/Memory") {}
