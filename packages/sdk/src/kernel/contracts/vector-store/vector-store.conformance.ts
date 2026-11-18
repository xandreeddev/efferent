import { Array as Arr, Effect, Order } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck, ConformanceFailure } from "@xandreed/core/kernel"
import { expect, refuses, show, unexpected } from "../conformance.entity.functions.js"
import type { Vector } from "../embedder/embedder.entity.js"
import { cosine } from "../embedder/embedder.entity.functions.js"
import { VectorKey } from "./vector-store.entity.js"
import type { Scored, SearchOptions, VectorEntry } from "./vector-store.entity.js"
import type { VectorStore } from "./vector-store.port.js"

type VectorStoreShape = Context.Service.Shape<typeof VectorStore>

/**
 * A store as the kit opens it: a fresh, empty one per check, released with its scope.
 *
 * @public
 */
export interface VectorStoreSubject {
  readonly open: Effect.Effect<VectorStoreShape, never, Scope.Scope>
}

/** How far a score may be from the cosine it stands for: a store may keep its numbers in single precision. */
const CLOSE = 1e-6

const key = (text: string): VectorKey => VectorKey.make(text)
const entry = (text: string, vector: Vector): VectorEntry => ({ key: key(text), vector })
const keysOf = (found: ReadonlyArray<Scored>): ReadonlyArray<string> => found.map((scored) => scored.key)
const sortedKeys = (found: ReadonlyArray<Scored>): ReadonlyArray<string> => Arr.sort(keysOf(found), Order.String)

/** A search that must find exactly `keys`, in that order. */
const finds = (store: VectorStoreShape, check: string, vector: Vector, options: SearchOptions, keys: ReadonlyArray<string>, what: string) =>
  Effect.flatMap(store.search(vector, options), (found) =>
    expect(check, show(keysOf(found)) === show(keys), `${what}: a search for ${show(vector)} found ${show(keysOf(found))}, not ${show(keys)}`))

/** Each vector a check of order keeps, and the vector it searches for: every score a different one. */
const query: Vector = [1, 0, 0]
const ordered: ReadonlyArray<VectorEntry> = [
  entry("a", [1, 1, 0]),
  entry("b", [-1, 0.5, 0]),
  entry("c", [0, 1, 0]),
  entry("d", [1, 0, 0]),
  entry("e", [2, 1, 0]),
]

const checks: ReadonlyArray<readonly [string, string, (store: VectorStoreShape) => Effect.Effect<void, ConformanceFailure>]> = [
  ["replace", "a key put again is replaced", (store) => Effect.gen(function* () {
    yield* store.put([entry("a", [1, 0, 0])])
    yield* store.put([entry("a", [0, 1, 0])])
    const found = yield* store.search([0, 1, 0], { limit: 10 })
    yield* expect("replace", found.length === 1 && found[0]?.key === "a" && Math.abs((found[0]?.score ?? 0) - 1) <= CLOSE,
      `"a" put twice, the second time as [0,1,0], and searched for by [0,1,0], found ${show(found)}`)
  }).pipe(unexpected("replace"))],
  ["order", "a search finds the keys by cosine, best first, each with its cosine", (store) => Effect.gen(function* () {
    yield* store.put(ordered)
    const found = yield* store.search(query, { limit: 10 })
    yield* expect("order", show(keysOf(found)) === show(["d", "e", "a", "c", "b"]), `a search for ${show(query)} found ${show(keysOf(found))}, not ["d","e","a","c","b"], best first`)
    for (const { key, score } of found) {
      const kept = ordered.find((each) => each.key === key)
      const expected = kept === undefined ? Number.NaN : cosine(query, kept.vector)
      yield* expect("order", Math.abs(score - expected) <= CLOSE, `${show(key)} was found with the score ${score}, where its cosine is ${expected}`)
    }
  }).pipe(unexpected("order"))],
  ["ties", "keys of one score are found in code unit order", (store) => Effect.gen(function* () {
    const tied: Vector = [0.5, 0.5, 0]
    yield* store.put(["b", "a", "c", "B"].map((text) => entry(text, tied)))
    yield* finds(store, "ties", query, { limit: 10 }, ["B", "a", "b", "c"], "four keys of one vector, put as b, a, c, B")
  }).pipe(unexpected("ties"))],
  ["limit", "a search finds at most its limit, and a limit that is none is refused", (store) => Effect.gen(function* () {
    yield* store.put(ordered)
    for (const [limit, count] of [[2, 2], [5, 5], [9, 5]] as const) {
      const found = yield* store.search(query, { limit })
      yield* expect("limit", found.length === count, `a search with the limit ${limit}, over ${ordered.length} vectors, found ${found.length}`)
    }
    for (const limit of [0, 1.5]) {
      yield* refuses("limit", `a search with the limit ${limit}`, store.search(query, { limit }), (error) => error._tag === "VectorsRefused" && error.reason === "limit")
    }
  }).pipe(unexpected("limit"))],
  ["among", "a search among keys finds only those, passes over those not stored, and still fills its limit", (store) => Effect.gen(function* () {
    yield* store.put([
      entry("k1", [1, 0, 0]),
      entry("k2", [1, 0.25, 0]),
      entry("k3", [1, 0.5, 0]),
      entry("k4", [1, 1, 0]),
      entry("k5", [0.5, 1, 0]),
      entry("k6", [0, 1, 0]),
    ])
    const among = ["x1", "x2", "k5", "k3", "k6", "x3"].map(key)
    const found = yield* store.search(query, { limit: 3, among })
    yield* expect("among", show(sortedKeys(found)) === show(["k3", "k5", "k6"]), `a search with the limit 3 among ${show(among)}, where x1, x2 and x3 are not stored, found ${show(keysOf(found))}, not k3, k5 and k6`)
    yield* finds(store, "among", query, { limit: 3, among: [key("x1")] }, [], "among a key that is not stored")
    yield* finds(store, "among", query, { limit: 3, among: [] }, [], "among no keys")
    yield* finds(store, "among", query, { limit: 3, among: [key("k1"), key("k1")] }, ["k1"], "among one key given twice")
  }).pipe(unexpected("among"))],
  ["has", "has gives the keys given that are stored, in the order given, each once", (store) => Effect.gen(function* () {
    yield* store.put([entry("a", [1, 0, 0]), entry("b", [0, 1, 0])])
    const stored = yield* store.has(["c", "b", "a", "b"].map(key))
    yield* expect("has", show(stored) === show(["b", "a"]), `with a and b stored, has of c, b, a and b gave ${show(stored)}, not ["b","a"]`)
    const none = yield* store.has([])
    yield* expect("has", none.length === 0, `has of no keys gave ${show(none)}`)
  }).pipe(unexpected("has"))],
  ["dimension", "a vector of another length is refused, and nothing of its put is kept", (store) => Effect.gen(function* () {
    yield* store.put([entry("a", [1, 0, 0])])
    yield* refuses("dimension", "a put of b, of three numbers, and c, of two, into a store of three", store.put([entry("b", [0, 1, 0]), entry("c", [1, 0])]),
      (error) => error._tag === "VectorsRefused" && error.reason === "dimension")
    yield* finds(store, "dimension", [0, 1, 0], { limit: 10 }, ["a"], "after a refused put of b and c")
    yield* refuses("dimension", "a search for a vector of two numbers in a store of three", store.search([1, 0], { limit: 10 }),
      (error) => error._tag === "VectorsRefused" && error.reason === "dimension")
  }).pipe(unexpected("dimension"))],
  ["empty", "a search of an empty store finds nothing", (store) => Effect.gen(function* () {
    yield* finds(store, "empty", query, { limit: 5 }, [], "in an empty store")
    yield* finds(store, "empty", [1, 0], { limit: 5, among: [key("a")] }, [], "among a key, in an empty store")
  }).pipe(unexpected("empty"))],
]

/**
 * The `VectorStore` contract as checks (ADR 0021), each on a fresh, empty store: a key put again is replaced
 * (`replace`); a search finds keys by cosine, best first, each with its cosine within 0.000001 (`order`); keys of one
 * score are found in code unit order (`ties`); a search finds at most its limit, and a limit that is no whole number
 * of at least 1 is refused (`limit`); a search among keys finds only those, passes over keys not stored, and still
 * fills its limit (`among`); `has` gives the stored keys of those given, in their order, each once (`has`); a vector
 * of another length than the store's is refused, by a put, which keeps none of its entries, and by a search
 * (`dimension`); an empty store finds nothing, whatever the vector's length (`empty`). Every vector the kit keeps
 * holds numbers single precision keeps exactly.
 *
 * @public
 */
export const vectorStoreConformance = (subject: VectorStoreSubject): ReadonlyArray<ConformanceCheck> =>
  checks.map(([id, name, run]) => ({ id, name, run: Effect.scoped(Effect.flatMap(subject.open, run)) }))
