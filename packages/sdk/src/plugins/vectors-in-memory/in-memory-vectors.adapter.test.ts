import { describe, expect, test } from "bun:test"
import { Brand, Effect } from "effect"
import type { Context } from "effect"
import { VectorKey } from "../../contracts/vector-store/vector-store.entity.js"
import type { VectorsRefused, VectorsUnavailable } from "../../contracts/vector-store/vector-store.entity.js"
import { VectorStore } from "../../contracts/vector-store/vector-store.port.js"
import { inMemoryVectors } from "./in-memory-vectors.adapter.js"

const key = (text: string) => VectorKey.make(text)
const storing = <A, E>(use: (store: Context.Service.Shape<typeof VectorStore>) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.provide(Effect.flatMap(VectorStore, use), inMemoryVectors()))

/** A call whose medium cannot fail here: only its refusal is left. */
const refusing = <A, R>(call: Effect.Effect<A, VectorsRefused | VectorsUnavailable, R>) => Effect.catchTag(call, "VectorsUnavailable", (error) => Effect.die(error))

describe("the store of vectors in memory", () => {
  test("a key that is no key, or numbers that are no vector, refuse the put whole", async () => {
    const refused = await storing((store) => Effect.gen(function* () {
      const noKey = yield* Effect.flip(refusing(store.put([{ key: key("a"), vector: [1, 0] }, { key: Brand.nominal<VectorKey>()(""), vector: [0, 1] }])))
      const noVector = yield* Effect.flip(refusing(store.put([{ key: key("a"), vector: [1, 0] }, { key: key("b"), vector: [Number.POSITIVE_INFINITY, 0] }])))
      const kept = yield* store.has([key("a"), key("b")])
      return { noKey: [noKey._tag, noKey.reason, noKey.message], noVector: [noVector._tag, noVector.reason], kept }
    }))
    expect(refused).toEqual({
      noKey: ["VectorsRefused", "key", "\"\" is no key: a key is 1 to 400 characters. Nothing of this put was kept."],
      noVector: ["VectorsRefused", "vector"],
      kept: [],
    })
  })

  test("a refused put sets no length: the next put of another length is kept", async () => {
    const found = await storing((store) => Effect.gen(function* () {
      yield* Effect.flip(store.put([{ key: key("a"), vector: [1, 0] }, { key: key("b"), vector: [1, 0, 0] }]))
      yield* store.put([{ key: key("c"), vector: [0, 0, 1] }])
      return yield* store.search([0, 0, 1], { limit: 5 })
    }))
    expect(found).toEqual([{ key: key("c"), score: 1 }])
  })

  test("a vector changed by its caller after it was put is kept as it was put", async () => {
    const vector = [1, 0]
    const found = await storing((store) => Effect.gen(function* () {
      yield* store.put([{ key: key("a"), vector }])
      vector[0] = 0
      vector[1] = 1
      return yield* store.search([1, 0], { limit: 1 })
    }))
    expect(found).toEqual([{ key: key("a"), score: 1 }])
  })

  test("each build is a store of its own", async () => {
    const layer = inMemoryVectors()
    const put = Effect.provide(Effect.flatMap(VectorStore, (store) => store.put([{ key: key("a"), vector: [1] }])), layer)
    const has = Effect.provide(Effect.flatMap(VectorStore, (store) => store.has([key("a")])), layer)
    await Effect.runPromise(put)
    expect(await Effect.runPromise(has)).toEqual([])
  })
})
