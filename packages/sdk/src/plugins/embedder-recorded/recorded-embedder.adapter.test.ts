import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Context } from "effect"
import { Embedder } from "../../contracts/embedder/embedder.port.js"
import type { RecordedOptions } from "./recorded-embedder.adapter.js"
import { recordedEmbedder } from "./recorded-embedder.adapter.js"

const options: RecordedOptions = {
  model: "e5-small-v2",
  vectors: {
    query: { "Who employs Ana?": [0.25, 0.5] },
    passage: { "Ana works at Acme.": [0.5, 0.25], "Acme is in Lisbon.": [1, 0] },
  },
}

const embedding = <A, E>(use: (embedder: Context.Service.Shape<typeof Embedder>) => Effect.Effect<A, E>, given: RecordedOptions = options) =>
  Effect.runPromise(Effect.provide(Effect.flatMap(Embedder, use), recordedEmbedder(given)))

describe("the recorded embedder", () => {
  test("names its model, and answers each text with the vector recorded for it as what it is asked as, in order", async () => {
    expect(await embedding((embedder) => Effect.succeed(embedder.model))).toBe("e5-small-v2")
    expect(await embedding((embedder) => embedder.embed(["Acme is in Lisbon.", "Ana works at Acme."], "passage"))).toEqual([[1, 0], [0.5, 0.25]])
    expect(await embedding((embedder) => embedder.embed(["Who employs Ana?"], "query"))).toEqual([[0.25, 0.5]])
    expect(await embedding((embedder) => embedder.embed([], "query"))).toEqual([])
  })

  test("a text it was not given, or not given as that, fails the call with EmbedFailed in words that name it", async () => {
    const failed = (texts: ReadonlyArray<string>, as: "query" | "passage") => embedding((embedder) => Effect.flip(embedder.embed(texts, as)))
    const asPassage = await failed(["Ana works at Acme.", "Who employs Ana?"], "passage")
    expect([asPassage._tag, asPassage.message]).toEqual(["EmbedFailed", "No passage vector is recorded for \"Who employs Ana?\"."])
    expect((await failed(["Ana works at Acme."], "query")).message).toBe("No query vector is recorded for \"Ana works at Acme.\".")
    expect((await failed([`${"a".repeat(80)} and more`], "query")).message).toBe(`No query vector is recorded for ${JSON.stringify("a".repeat(80))} [… 9 characters clipped].`)
  })

  test("vectors of two lengths, numbers that are no vector, or a model with no name are refused where they are written", () => {
    const refused = (given: RecordedOptions) => expect(() => recordedEmbedder(given))
    refused({ model: "m", vectors: { query: { q: [1, 0] }, passage: { p: [1, 0, 0] } } })
      .toThrow("recordedEmbedder: the passage vector of \"p\" is 3 numbers long, and the vectors before it 2")
    refused({ model: "m", vectors: { query: {}, passage: { p: [1, Number.NaN] } } })
      .toThrow("recordedEmbedder: the passage vector of \"p\" is no vector: its number at 1 is NaN, not a finite number")
    refused({ model: "m", vectors: { query: { q: [] }, passage: {} } })
      .toThrow("recordedEmbedder: the query vector of \"q\" is no vector: it holds no number")
    refused({ model: " ", vectors: { query: {}, passage: {} } })
      .toThrow("recordedEmbedder: a model is named by one or more characters")
  })

  test("a vector changed by its caller after it was recorded is answered as it was recorded", async () => {
    const vector = [1, 2]
    const layer = recordedEmbedder({ model: "m", vectors: { query: { q: vector }, passage: {} } })
    vector[0] = 9
    expect(await Effect.runPromise(Effect.provide(Effect.flatMap(Embedder, (embedder) => embedder.embed(["q"], "query")), layer))).toEqual([[1, 2]])
  })
})
