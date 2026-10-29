import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { TaskActivity, TaskRunner } from "@xandreed/core"
import { InProcessTaskRunnerLive } from "./task-runner.adapter.js"

const built = Layer.build(InProcessTaskRunnerLive()).pipe(Effect.map((context) => ({
  runner: Context.get(context, TaskRunner),
  activity: Context.get(context, TaskActivity),
})))

describe("InProcessTaskRunnerLive's TaskActivity", () => {
  test("work counts from the moment run hands it over until it ends, and idle waits for all of it", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { runner, activity } = yield* built
    expect(yield* activity.running).toBe(0)
    yield* activity.idle
    const releases = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
    yield* runner.run(() => Deferred.await(releases[0]!))
    expect(yield* activity.running).toBe(1)
    yield* runner.run(() => Deferred.await(releases[1]!))
    expect(yield* activity.running).toBe(2)
    const idle = yield* Effect.forkChild(activity.idle)
    yield* Deferred.succeed(releases[0]!, undefined)
    yield* Effect.yieldNow
    expect([yield* activity.running, idle.pollUnsafe()]).toEqual([1, undefined])
    yield* Deferred.succeed(releases[1]!, undefined)
    yield* Fiber.join(idle)
    expect(yield* activity.running).toBe(0)
  }))))

  test("work is forked and joins the set in one step: a caller interrupted as it hands work over leaves none outside the set", () => Effect.runPromise(Effect.gen(function* () {
    const scope = yield* Scope.make()
    const { runner, activity } = yield* built.pipe(Scope.provide(scope))
    const interrupted = yield* Deferred.make<void>()
    // The caller is interrupted while it forks the work (here by the work's own factory, as a racing interrupt
    // could): with a fork and an add in two steps, the add would be skipped and the work would run uncounted.
    const caller = yield* Effect.forkChild(Effect.withFiber((self) => runner.run(() => {
      self.interruptUnsafe()
      return Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
    })))
    expect(Exit.hasInterrupts(yield* Fiber.await(caller))).toBe(true)
    expect(yield* activity.running).toBe(1)
    // In the set, it is interrupted with the layer.
    yield* Scope.close(scope, Exit.void)
    yield* Deferred.await(interrupted)
    expect(yield* activity.running).toBe(0)
  })))

  test("closing the layer's scope interrupts the work still running, which then counts no more", () => Effect.runPromise(Effect.gen(function* () {
    const scope = yield* Scope.make()
    const { runner, activity } = yield* built.pipe(Scope.provide(scope))
    const interrupted = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    yield* runner.run(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))))
    yield* Deferred.await(started)
    expect(yield* activity.running).toBe(1)
    yield* Scope.close(scope, Exit.void)
    yield* Deferred.await(interrupted)
    expect(yield* activity.running).toBe(0)
    yield* activity.idle
  })))
})
