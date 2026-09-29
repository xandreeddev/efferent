import { Clock, Effect, FiberSet, Layer, Option } from "effect"
import { TaskRunner } from "@xandreed/core"

/**
 * Background work on fibers of this process, each on its own fiber (it
 * keeps none of the starting turn's services), all interrupted when the
 * layer's scope closes: an interrupted task's turn ends as interrupted.
 * With `maxMs`, each piece of work must be done that long after it starts.
 */
export const InProcessTaskRunnerLive = (options?: { readonly maxMs?: number }): Layer.Layer<TaskRunner> => Layer.effect(TaskRunner, Effect.gen(function* () {
  const fibers = yield* FiberSet.make<void>()
  const context = yield* Effect.context<never>()
  return TaskRunner.of({
    run: (work) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const deadline = Option.map(Option.fromNullishOr(options?.maxMs), (ms) => now + ms)
      const fiber = yield* Effect.sync(() => Effect.runForkWith(context)(work(deadline)))
      yield* FiberSet.add(fibers, fiber)
    }),
  })
}))
