import { Effect, Queue } from "effect"
import type { SmithEvent } from "../../domain/SmithEvent.js"

/** Drain the smith event queue into the store — one Solid frame per event
 *  (the store's `reduce` wraps its writes in `batch`). */
export const runEventPump = (
  queue: Queue.Queue<SmithEvent>,
  reduce: (event: SmithEvent) => void,
): Effect.Effect<never> =>
  Effect.forever(
    Effect.flatMap(Queue.take(queue), (event) => Effect.sync(() => reduce(event))),
  )
