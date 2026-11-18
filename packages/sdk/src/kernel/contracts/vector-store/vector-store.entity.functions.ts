import { Array as Arr, Option, Order, Schema } from "effect"
import type { Vector } from "../embedder/embedder.entity.js"
import { cosine, notAVector, quoted } from "../embedder/embedder.entity.functions.js"
import { KEY_LIMIT, VectorKey, VectorsRefused } from "./vector-store.entity.js"
import type { Scored, SearchOptions, VectorEntry } from "./vector-store.entity.js"

const isKey = Schema.is(VectorKey)

/** Best first: the higher score, then the key, by code unit. */
const bestFirst: Order.Order<Scored> = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (scored: Scored) => scored.score),
  Order.mapInput(Order.String, (scored: Scored) => scored.key),
)

const KEPT_NONE = "Nothing of this put was kept."

/**
 * Why a store whose vectors are `dimension` numbers long (none, for a store that holds none) refuses a put, or
 * nothing when it takes it: a key that is no key, numbers that are no vector, or a vector of another length than the
 * store's or, in an empty store, than the put's first. A put is taken whole or not at all.
 */
export const refusedPut = (dimension: Option.Option<number>, entries: ReadonlyArray<VectorEntry>): Option.Option<VectorsRefused> => {
  let length = dimension
  for (const { key, vector } of entries) {
    if (!isKey(key)) {
      return Option.some(new VectorsRefused({ reason: "key", message: `${quoted(key)} is no key: a key is 1 to ${KEY_LIMIT} characters. ${KEPT_NONE}` }))
    }
    const problem = notAVector(vector)
    if (Option.isSome(problem)) {
      return Option.some(new VectorsRefused({ reason: "vector", message: `The vector of ${quoted(key)} is no vector: ${problem.value}. ${KEPT_NONE}` }))
    }
    if (Option.isSome(length) && length.value !== vector.length) {
      return Option.some(new VectorsRefused({ reason: "dimension", message: `The vector of ${quoted(key)} is ${vector.length} numbers long, and this store's are ${length.value}. ${KEPT_NONE}` }))
    }
    length = Option.some(vector.length)
  }
  return Option.none()
}

/**
 * Why a store whose vectors are `dimension` numbers long refuses a search, or nothing when it takes it: a limit that
 * is no whole number of at least 1, numbers that are no vector, or a vector of another length than the store's. A
 * store that holds no vector takes a search for any vector, and finds nothing.
 */
export const refusedSearch = (dimension: Option.Option<number>, vector: Vector, options: SearchOptions): Option.Option<VectorsRefused> => {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    return Option.some(new VectorsRefused({ reason: "limit", message: `The limit ${String(options.limit)} is no whole number of at least 1.` }))
  }
  const problem = notAVector(vector)
  if (Option.isSome(problem)) return Option.some(new VectorsRefused({ reason: "vector", message: `The vector searched for is no vector: ${problem.value}.` }))
  return Option.isSome(dimension) && dimension.value !== vector.length
    ? Option.some(new VectorsRefused({ reason: "dimension", message: `The vector searched for is ${vector.length} numbers long, and this store's are ${dimension.value}.` }))
    : Option.none()
}

/**
 * What a search finds among the vectors `stored`: the keys most alike to `vector` by cosine, best first, keys of one
 * score by code unit, at most `limit`. Given `among`, only its keys are candidates, a key not stored passed over, so
 * the result still holds `limit` keys when that many of them are stored.
 */
export const ranked = (stored: ReadonlyMap<VectorKey, Vector>, vector: Vector, options: SearchOptions): ReadonlyArray<Scored> => {
  const candidates = options.among === undefined ? Array.from(stored.keys()) : Arr.dedupe(options.among).filter((key) => stored.has(key))
  const scored = candidates.flatMap((key): ReadonlyArray<Scored> => {
    const kept = stored.get(key)
    return kept === undefined ? [] : [{ key, score: cosine(vector, kept) }]
  })
  return Arr.sort(scored, bestFirst).slice(0, options.limit)
}
