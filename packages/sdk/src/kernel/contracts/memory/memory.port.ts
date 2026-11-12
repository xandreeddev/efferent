import { Context } from "effect"
import type { Effect } from "effect"
import type { JournalStorageError, ListenerFailed, OpenSession, PluginFailure, UnknownRecord } from "@xandreed/core/kernel"
import type { ModelRequest, StepNumber } from "../loop/request.entity.js"

/**
 * What memory can fail with: storage, a record it may not skip, a waiting listener, or an error of its own (over budget is one).
 *
 * @public
 */
export type MemoryFailure = JournalStorageError | UnknownRecord | ListenerFailed | PluginFailure

/**
 * What decides what the model is sent, and owns the budget. It is one
 * function and keeps nothing by contract: `build` reads the session's
 * journal, may append a record of its own through the open session it is
 * given, and returns pointers. A memory that wants a store or a state of
 * its own keeps it where its plugin is made. `memoryConformance` is the
 * contract as runnable checks.
 */
export class Memory extends Context.Service<Memory, {
  /**
   * The request of this step of the session's open turn: pointers at the
   * records of the journal whose messages the model is sent, with the
   * estimate and the budget. Text memory writes for the model itself is
   * appended to the open session first, as memory's own record bearing a
   * message, and pointed at.
   */
  readonly build: (session: OpenSession, step: StepNumber) => Effect.Effect<ModelRequest, MemoryFailure>
}>()("@xandreed/core/kernel/Memory") {}
