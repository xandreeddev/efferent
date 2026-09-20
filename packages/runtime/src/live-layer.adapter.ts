import { Context, Effect, Exit, Ref, Scope } from "effect"
import type { Layer } from "effect"
import * as Layers from "effect/Layer"
import { HarnessError } from "@xandreed/core"

type Generation<A> = {
  readonly id: number
  readonly services: Context.Context<A>
  readonly scope: Scope.CloseableScope
  readonly leases: number
  readonly retired: boolean
}

/** Scoped generations for replaceable modules. Each use pins one successful
 * generation; retiring a generation does not close its resources until its
 * last user completes. Failed staging never replaces the working services. */
export const makeLiveLayer = <A, E, R>(initial: Layer.Layer<A, E, R>) => Effect.gen(function* () {
  const dependencies = yield* Effect.context<R>()
  const gate = yield* Effect.makeSemaphore(1)
  const generations = yield* Ref.make<ReadonlyMap<number, Generation<A>>>(new Map())
  const current = yield* Ref.make(0)
  const closed = yield* Ref.make(false)
  const unavailable = () => new HarnessError({ code: "module.closed", message: "Module registry is closed" })
  const stage = (layer: Layer.Layer<A, E, R>, id: number) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const scope = yield* Scope.make()
    const services = yield* restore(Layers.buildWithScope(layer, scope).pipe(Effect.provide(dependencies))).pipe(
      Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void),
    )
    return { id, services, scope, leases: 0, retired: false } satisfies Generation<A>
  }))
  const first = yield* stage(initial, 0)
  yield* Ref.set(generations, new Map([[0, first]]))
  yield* Effect.addFinalizer(() => gate.withPermits(1)(Effect.gen(function* () {
    yield* Ref.set(closed, true)
    const remaining = yield* Ref.getAndSet(generations, new Map())
    yield* Effect.forEach(remaining.values(), (generation) => Scope.close(generation.scope, Exit.void))
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
  const release = (lease: Generation<A>) => gate.withPermits(1)(Effect.gen(function* () {
    const all = yield* Ref.get(generations)
    const generation = all.get(lease.id)
    if (!generation) return
    const next = { ...generation, leases: generation.leases - 1 }
    if (next.retired && next.leases === 0) {
      yield* Ref.set(generations, new Map([...all].filter(([id]) => id !== next.id)))
      yield* Scope.close(next.scope, Exit.void)
    } else yield* Ref.set(generations, new Map([...all, [next.id, next]]))
  }))
  return {
    use: <B, E2, R2>(effect: Effect.Effect<B, E2, R2>) => Effect.acquireUseRelease(acquire, (generation) => effect.pipe(Effect.provide(generation.services)), release),
    generation: Ref.get(current),
    replace: (layer: Layer.Layer<A, E, R>) => gate.withPermits(1)(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      if (yield* Ref.get(closed)) return yield* Effect.fail(unavailable())
      const id = yield* Ref.get(current)
      const next = yield* restore(stage(layer, id + 1))
      const all = yield* Ref.get(generations)
      const previous = all.get(id)
      const retained = [...all].filter(([key]) => key !== id)
      yield* Ref.set(generations, new Map([...retained, ...(previous && previous.leases > 0 ? [[id, { ...previous, retired: true }] as const] : []), [next.id, next]]))
      yield* Ref.set(current, next.id)
      if (previous && previous.leases === 0) yield* Scope.close(previous.scope, Exit.void)
      return next.id
    }))),
  }
})
