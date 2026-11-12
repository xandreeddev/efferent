import { Schema } from "effect"
import type { Context, Effect } from "effect"
import type { AiError, LanguageModel } from "effect/ai"
import type { ContextManager, OpenContext } from "./context-manager.port.js"
import type { Events } from "./events.port.js"
import { SessionId } from "./ids.entity.js"
import type { StorageError } from "./journal.entity.js"
import type { Reply, ToolsNotRun } from "./message.entity.js"
import type { ContextError, Limits, RequestRefused } from "./request.entity.js"
import type { SessionRefused } from "./session.entity.js"
import type { OpenSession, Sessions } from "./sessions.port.js"

/** What a turn is run with: the session and the user's message. */
export const TurnInput = Schema.Struct({ session: SessionId, message: Schema.String })
export type TurnInput = typeof TurnInput.Type

/**
 * What a step loop can fail with: a port's failure, a request the engine
 * refused, the model's own error, or tools nothing ran.
 *
 * @public
 */
export type LoopError = StorageError | SessionRefused | ContextError | RequestRefused | ToolsNotRun | AiError.AiError

/**
 * The steps of one turn, from its open session and context to its reply.
 *
 * @public
 */
export type StepLoop = (agent: Agent, session: OpenSession, context: OpenContext) => Effect.Effect<Reply, LoopError>

/** An agent as plain data: the model, the system text, the limits and its parts. */
export interface Agent {
  readonly model: LanguageModel.LanguageModel
  readonly system: string
  readonly limits: Limits
  readonly sessions: Context.Service.Shape<typeof Sessions>
  readonly context: Context.Service.Shape<typeof ContextManager>
  readonly events: Context.Service.Shape<typeof Events>
  readonly loop: StepLoop
}
