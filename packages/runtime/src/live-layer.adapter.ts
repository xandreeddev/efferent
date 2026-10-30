import { Context, Effect, Exit, Ref, Scope, Semaphore } from "effect"
import type { Layer } from "effect"
import * as Layers from "effect/Layer"
import { HarnessError, replayableContext } from "@xandreed/core"

type Generation<A> = {
  readonly id: number
  readonly services: Context.Context<A>
  readonly scope: Scope.Closeable
  readonly leases: number
  readonly retired: boolean
}

/** Scoped generations for replaceable modules. Each use pins one successful
 * generation; retiring a generation does not close its resources until its
 * last user completes. Failed staging never replaces the working services.
 * A replacement builds while uses go on with the working generation, and
 * takes their gate only to swap; replacements run one at a time. Scopes are
 * closed outside the gate, so a slow finalizer holds up no use either.
 *
 * @public
 */
export const makeLiveLayer = Effect.fnUntraced(function* <A, E, R>(initial: Layer.Layer<A, E, R>) {
  // Each stage builds with these, traced where it is staged (a replacement under its caller's span).
  const dependencies = replayableContext(yield* Effect.context<R>())
  const gate = yield* Semaphore.make(1)
  const replacing = yield* Semaphore.make(1)
  const generations = yield* Ref.make<ReadonlyMap<number, Generation<A>>>(new Map())
  const current = yield* Ref.make(0)
  const closed = yield* Ref.make(false)
  const unavailable = () => new HarnessError({ code: "module.closed", message: "Module registry is closed" })
  const stage = (layer: Layer.Layer<A, E, R>, id: number) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const scope = yield* Scope.make()
    // Each generation builds afresh: a replacement never reuses an instance memoized elsewhere.
    const memoMap = yield* Layers.makeMemoMap
    const services = yield* restore(Layers.buildWithMemoMap(layer, memoMap, scope).pipe(Effect.provide(dependencies))).pipe(
      Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void),
    )
    return { id, services, scope, leases: 0, retired: false } satisfies Generation<A>
  }))
  const first = yield* stage(initial, 0)
  yield* Ref.set(generations, new Map([[0, first]]))
  yield* Effect.addFinalizer(() => gate.withPermits(1)(Effect.gen(function* () {
    yield* Ref.set(closed, true)
    const remaining = yield* Ref.getAndSet(generations, new Map())
    yield* Effect.forEach(remaining.values(), (generation) => Scope.close(generation.scope, Exit.void), { concurrency: 1 })
  })))
  const acquire = gate.withPermits(1)(Effect.gen(function* () {
    if (yield* Ref.get(closed)) return yield* Effect.fail(unavailable())
    const id = yield* Ref.get(current)
    const all = yield* Ref.get(generations)
    const generation = all.get(id)
    if (!generation) return yield* Effect.fail(unavailable())
    yield* Ref.set(generations, new Map([...all, [id, { ...generation, leases: generation.leases + 1 }]]))
    return generation
  }))
  const closeAll = (scopes: ReadonlyArray<Scope.Closeable>) => Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { concurrency: 1, discard: true })
  const release = (lease: Generation<A>) => gate.withPermits(1)(Effect.gen(function* () {
    const all = yield* Ref.get(generations)
    const generation = all.get(lease.id)
    if (!generation) return []
    const next = { ...generation, leases: generation.leases - 1 }
    if (next.retired && next.leases === 0) {
      yield* Ref.set(generations, new Map([...all].filter(([id]) => id !== next.id)))
      return [next.scope]
    }
    yield* Ref.set(generations, new Map([...all, [next.id, next]]))
    return []
  })).pipe(Effect.flatMap(closeAll))
  return {
    use: <B, E2, R2>(effect: Effect.Effect<B, E2, R2>) => Effect.acquireUseRelease(acquire, (generation) => effect.pipe(Effect.provide(generation.services)), release),
    generation: Ref.get(current),
    replace: (layer: Layer.Layer<A, E, R>) => replacing.withPermits(1)(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      if (yield* Ref.get(closed)) return yield* Effect.fail(unavailable())
      // Only replacements move `current`, and they run one at a time: it is still this id at the swap.
      const next = yield* restore(stage(layer, (yield* Ref.get(current)) + 1))
      const swap = yield* gate.withPermits(1)(Effect.gen(function* () {
        // Closed while staging: the staged generation is closed instead of served.
        if (yield* Ref.get(closed)) return { swapped: false, close: [next.scope] }
        const id = yield* Ref.get(current)
        const all = yield* Ref.get(generations)
        const previous = all.get(id)
        const retained = [...all].filter(([key]) => key !== id)
        yield* Ref.set(generations, new Map([...retained, ...(previous && previous.leases > 0 ? [[id, { ...previous, retired: true }] as const] : []), [next.id, next]]))
        yield* Ref.set(current, next.id)
        return { swapped: true, close: previous && previous.leases === 0 ? [previous.scope] : [] }
      }))
      yield* closeAll(swap.close)
      if (!swap.swapped) return yield* Effect.fail(unavailable())
      return next.id
    }))),
  }
})
