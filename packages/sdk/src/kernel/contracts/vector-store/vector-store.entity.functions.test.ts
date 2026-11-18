import { describe, expect, test } from "bun:test"
import { Brand, Option } from "effect"
import { VectorKey } from "./vector-store.entity.js"
import type { Vector } from "../embedder/embedder.entity.js"
import { ranked, refusedPut, refusedSearch } from "./vector-store.entity.functions.js"

const key = (text: string) => VectorKey.make(text)
const reasonAndWords = (refused: ReturnType<typeof refusedPut>) => Option.map(refused, (error) => [error.reason, error.message])

describe("what a store refuses", () => {
  test("a put is refused whole, in words, for a vector of another length, numbers that are no vector, or a key that is no key", () => {
    expect(reasonAndWords(refusedPut(Option.some(3), [{ key: key("a"), vector: [1, 0, 0] }, { key: key("b"), vector: [1, 0] }])))
      .toEqual(Option.some(["dimension", "The vector of \"b\" is 2 numbers long, and this store's are 3. Nothing of this put was kept."]))
    // An empty store takes the length of the put's first vector, and holds the rest to it.
    expect(reasonAndWords(refusedPut(Option.none(), [{ key: key("a"), vector: [1, 0] }, { key: key("b"), vector: [1, 0, 0] }])))
      .toEqual(Option.some(["dimension", "The vector of \"b\" is 3 numbers long, and this store's are 2. Nothing of this put was kept."]))
    expect(reasonAndWords(refusedPut(Option.none(), [{ key: key("a"), vector: [1, Number.NaN] }])))
      .toEqual(Option.some(["vector", "The vector of \"a\" is no vector: its number at 1 is NaN, not a finite number. Nothing of this put was kept."]))
    const long = Brand.nominal<VectorKey>()("k".repeat(401))
    expect(reasonAndWords(refusedPut(Option.none(), [{ key: long, vector: [1] }])))
      .toEqual(Option.some(["key", `${JSON.stringify("k".repeat(80))} [… 321 characters clipped] is no key: a key is 1 to 400 characters. Nothing of this put was kept.`]))
    expect(refusedPut(Option.some(2), [{ key: key("a"), vector: [0, 0] }, { key: key("a"), vector: [1, 1] }])).toEqual(Option.none())
    expect(refusedPut(Option.some(2), [])).toEqual(Option.none())
  })

  test("a search is refused, in words, for a limit that is none, numbers that are no vector, or a vector of another length", () => {
    expect(reasonAndWords(refusedSearch(Option.some(3), [1, 0, 0], { limit: 0 }))).toEqual(Option.some(["limit", "The limit 0 is no whole number of at least 1."]))
    expect(reasonAndWords(refusedSearch(Option.some(3), [1, 0, 0], { limit: 2.5 }))).toEqual(Option.some(["limit", "The limit 2.5 is no whole number of at least 1."]))
    expect(reasonAndWords(refusedSearch(Option.some(3), [], { limit: 1 }))).toEqual(Option.some(["vector", "The vector searched for is no vector: it holds no number."]))
    expect(reasonAndWords(refusedSearch(Option.some(3), [1, 0], { limit: 1 }))).toEqual(Option.some(["dimension", "The vector searched for is 2 numbers long, and this store's are 3."]))
    // A store that holds no vector has no length to hold a search to.
    expect(refusedSearch(Option.none(), [1, 0], { limit: 1 })).toEqual(Option.none())
  })
})

describe("what a search finds", () => {
  const stored = new Map<VectorKey, Vector>([
    [key("far"), [0, 1]],
    [key("near"), [1, 0.1]],
    [key("same"), [2, 0]],
    [key("b"), [1, 1]],
    [key("a"), [1, 1]],
  ])

  test("the most alike first, keys of one score by code unit, at most the limit", () => {
    expect(ranked(stored, [1, 0], { limit: 10 }).map((scored): string => scored.key)).toEqual(["same", "near", "a", "b", "far"])
    const [first, second, ...rest] = ranked(stored, [1, 0], { limit: 2 })
    expect<ReadonlyArray<unknown>>([first?.key, first?.score, second?.key, rest.length]).toEqual(["same", 1, "near", 0])
    expect(second?.score).toBeCloseTo(1 / Math.sqrt(1.01), 12)
  })

  test("among keys, only those, each once, a key not stored passed over, the limit still filled", () => {
    expect(ranked(stored, [1, 0], { limit: 2, among: [key("gone"), key("far"), key("far"), key("b"), key("a")] }).map((scored): string => scored.key)).toEqual(["a", "b"])
    expect(ranked(stored, [1, 0], { limit: 2, among: [] })).toEqual([])
  })
})
