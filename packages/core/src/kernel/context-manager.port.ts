import { Context } from "effect"
import type { Effect } from "effect"
import type { BuildInput, BuiltContext, ContextError } from "./request.entity.js"
import type { OpenSession } from "./sessions.port.js"

/**
 * A turn's context, opened once: it builds what each request of the turn sends.
 *
 * @public
 */
export interface OpenContext {
  /** The messages to send for this step, and the manager's own records about them. */
  readonly build: (input: BuildInput) => Effect.Effect<BuiltContext, ContextError>
}

/**
 * What decides the context of a request: which of the journal's messages
 * the model is sent. It reads the session's journal and its own records;
 * the engine checks what it builds and records it as sent. Its failures are
 * `ContextError`s.
 *
 * @public
 */
export class ContextManager extends Context.Service<ContextManager, {
  /** Open the context of the session's open turn. */
  readonly open: (session: OpenSession) => Effect.Effect<OpenContext, ContextError>
}>()("@xandreed/core/kernel/ContextManager") {}
