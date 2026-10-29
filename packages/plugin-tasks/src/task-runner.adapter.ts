import { Clock, Context, Effect, FiberSet, Layer, Option } from "effect"
import { TaskActivity, TaskRunner } from "@xandreed/core"

/**
 * Background work on fibers of this process, each on its own fiber (it
 * keeps none of the starting turn's services), all interrupted when the
 * layer's scope closes: an interrupted task's turn ends as interrupted.
 * With `maxMs`, each piece of work must be done that long after it starts.
 * The work runs with the services the layer was built with, its trace state
 * included (no `replayableContext`: a new fiber has no other): its spans nest
 * under the span current where the layer was built, and it reads the
 * `CurrentTraceContent` set there.
 * It also provides `TaskActivity`: the work running now, counted from the
 * moment `run` hands it over until it ends. The fiber is forked and joins
 * the set in one step, so a caller interrupted as it hands work over leaves
 * none running outside the set (uncounted, and not interrupted with it).
 */
export const InProcessTaskRunnerLive = (options?: { readonly maxMs?: number }): Layer.Layer<TaskRunner | TaskActivity> => Layer.effectContext(Effect.gen(function* () {
  const fibers = yield* FiberSet.make<void>()
  const context = yield* Effect.context<never>()
  const runner = TaskRunner.of({
    run: (work) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const deadline = Option.map(Option.fromNullishOr(options?.maxMs), (ms) => now + ms)
      yield* Effect.sync(() => FiberSet.addUnsafe(fibers, Effect.runForkWith(context)(work(deadline))))
    }),
  })
  const activity = TaskActivity.of({ running: FiberSet.size(fibers), idle: FiberSet.awaitEmpty(fibers) })
  return Context.make(TaskRunner, runner).pipe(Context.add(TaskActivity, activity))
}))
