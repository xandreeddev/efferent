import { Context } from "effect"
import type { Effect } from "effect"
import type { PluginFailure } from "./event.entity.js"
import type { RequestRefused } from "./request.entity.js"
import type { Reply, TurnInput } from "./loop.entity.js"
import type { TurnFailure } from "./sessions.port.js"

/**
 * What a turn can fail with: the session's refusals, a request that cannot be sent, or a plugin's own error (memory's, the model's, the loop's).
 *
 * @public
 */
export type LoopFailure = TurnFailure | RequestRefused | PluginFailure

/**
 * What runs a turn: from the user's message to the reply. It composes the
 * other plugins and decides the steps. `loopConformance` is the contract
 * as runnable checks.
 */
export class Loop extends Context.Service<Loop, {
  /** Run one turn of the session and return its reply. */
  readonly run: (input: TurnInput) => Effect.Effect<Reply, LoopFailure>
}>()("@xandreed/core/kernel/Loop") {}
