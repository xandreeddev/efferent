import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { Version } from "./testing/version.port.js"
import { makeLiveLayer } from "./live-layer.adapter.js"

test("replacements drain leased generations and failed stages preserve the working layer", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const disposed = yield* Ref.make<ReadonlyArray<number>>([])
    const layer = (value: number) => Layer.scoped(Version, Effect.acquireRelease(Effect.succeed({ value }), () => Ref.update(disposed, (prior) => [...prior, value])))
    const registry = yield* makeLiveLayer(layer(1) as Layer.Layer<Version, string>)
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const old = yield* Effect.fork(registry.use(Effect.gen(function* () {
      const value = (yield* Version).value
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(finish)
      return value
    })))
    yield* Deferred.await(entered)
    yield* registry.replace(layer(2))
    expect(yield* Ref.get(disposed)).toEqual([])
    expect(yield* registry.use(Version.pipe(Effect.map((value) => value.value)))).toBe(2)
    expect((yield* registry.replace(Layer.effect(Version, Effect.fail("bad config"))).pipe(Effect.either))._tag).toBe("Left")
    expect(yield* registry.generation).toBe(1)
    yield* Deferred.succeed(finish, undefined)
    expect(yield* Fiber.join(old)).toBe(1)
    expect(yield* Ref.get(disposed)).toEqual([1])
  })))
})
