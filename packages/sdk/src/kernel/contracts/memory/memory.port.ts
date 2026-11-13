import { Context } from "effect"
import type { Effect } from "effect"
import type { Prompt } from "effect/ai"
import type { JournalStorageError, ListenerFailed, OpenSession, PluginFailure, UnknownRecord } from "@xandreed/core/kernel"

/**
 * What memory can fail with: storage, a record it may not skip, a waiting listener, or an error of its own (over budget is one).
 *
 * @public
 */
export type MemoryFailure = JournalStorageError | UnknownRecord | ListenerFailed | PluginFailure

/**
 * What decides what of the journal the model sees: the layer between what
 * is stored and what goes into a prompt. It is one function and keeps
 * nothing by contract: `context` reads the session's journal (the
 * conversation's records, tagged `conversation`, and its own), may append
 * a record of its own through the open session it is given (tagged
 * `memory`, derived from the conversation, never a copy of it), and returns
 * the messages that follow the system text, ready for the prompt. The
 * system text is the caller's: memory never sees or stores it. A budget,
 * when a memory has one, is its own option. `memoryConformance` is the
 * contract as runnable checks.
 */
export class Memory extends Context.Service<Memory, {
  /** The messages of the context for the session's open turn, in the order the model reads them, the system text left to the caller. */
  readonly context: (session: OpenSession) => Effect.Effect<ReadonlyArray<Prompt.MessageEncoded>, MemoryFailure>
}>()("@xandreed/core/kernel/Memory") {}
