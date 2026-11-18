import { Effect, Layer, Option, Ref } from "effect"
import type { Vector } from "../../contracts/embedder/embedder.entity.js"
import type { VectorKey, VectorsRefused } from "../../contracts/vector-store/vector-store.entity.js"
import { ranked, refusedPut, refusedSearch } from "../../contracts/vector-store/vector-store.entity.functions.js"
import { VectorStore } from "../../contracts/vector-store/vector-store.port.js"

/** What the store holds: its vectors' length, once it keeps one, and each vector under its key. */
interface Held {
  readonly dimension: Option.Option<number>
  readonly vectors: ReadonlyMap<VectorKey, Vector>
}

/**
 * A store of vectors in memory (ADR 0021): `VectorStore` over a map, gone when the layer's scope closes, which is
 * what an index of the journal may be: lost, it is made again. Each build is a store of its own. A put is one
 * `Ref.modify`: what it refuses and what it keeps are decided in one step, whole or nothing.
 *
 * @public
 */
export const inMemoryVectors = (): Layer.Layer<VectorStore> =>
  Layer.effect(VectorStore, Effect.gen(function* () {
    const held = yield* Ref.make<Held>({ dimension: Option.none(), vectors: new Map() })
    return VectorStore.of({
      put: (entries) => Effect.flatten(Ref.modify(held, (now): readonly [Effect.Effect<void, VectorsRefused>, Held] =>
        Option.match(refusedPut(now.dimension, entries), {
          onSome: (refused) => [Effect.fail(refused), now],
          onNone: () => {
            const first = entries[0]
            if (first === undefined) return [Effect.void, now]
            const vectors = new Map(now.vectors)
            for (const { key, vector } of entries) vectors.set(key, [...vector])
            return [Effect.void, { dimension: Option.some(first.vector.length), vectors }]
          },
        }))),
      search: (vector, options) => Effect.flatMap(Ref.get(held), (now) => Option.match(refusedSearch(now.dimension, vector, options), {
        onSome: (refused) => Effect.fail(refused),
        onNone: () => Effect.succeed(ranked(now.vectors, vector, options)),
      })),
      has: (keys) => Effect.map(Ref.get(held), (now) => {
        const seen = new Set<VectorKey>()
        return keys.filter((key) => {
          if (seen.has(key) || !now.vectors.has(key)) return false
          seen.add(key)
          return true
        })
      }),
    })
  }))
