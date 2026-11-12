import { Context } from "effect"
import type { Effect } from "effect"
import type { LiveEvent } from "./event.entity.js"

/**
 * The live stream of what happens in sessions. Publishing never fails and
 * stores nothing: the journal is what is complete.
 *
 * @public
 */
export class Events extends Context.Service<Events, {
  /** Hand an event to whoever follows the stream. */
  readonly publish: (event: LiveEvent) => Effect.Effect<void>
}>()("@xandreed/core/kernel/Events") {}
