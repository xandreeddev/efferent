// The vectors lesson 20 ships, as the page reads them: a vector round-trips
// through its text, within a cosine of 0.9999; each entry is keyed by the
// kernel's `meaningKey` for its text; and a file of another model, a text that
// is no base64, and a vector of the wrong length are refused in words.
import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { meaningKey } from "@xandreed/sdk/kernel"
import { decodeVector, EMBEDDER_MODEL, EMBEDDER_REVISION, encodeVector, shippedEntries, shippedFileOf } from "./shipped.ts"
import { shippedFile } from "./testing.ts"

const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
  const dot = (x: ReadonlyArray<number>, y: ReadonlyArray<number>) => x.reduce((sum, value, at) => sum + value * (y[at] ?? 0), 0)
  return dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b))
}

describe("lesson 20's shipped vectors", () => {
  test("made by the page's model at its pinned revision, 384 numbers each, each under the kernel's key for its text", () => {
    const file = shippedFile()
    expect([file.model, file.revision, file.dimension]).toEqual([EMBEDDER_MODEL, EMBEDDER_REVISION, 384])
    const entries = Result.getOrThrow(shippedEntries(file))
    expect(entries).toHaveLength(557)
    expect(entries.every((entry) => entry.vector.length === 384)).toBe(true)
    const [text] = Object.keys(file.passages)
    expect(entries[0]?.key).toBe(Result.getOrThrow(meaningKey(EMBEDDER_MODEL, text ?? "")))
  })

  test("a vector round-trips through its text; a text that is no vector, a vector of another length, and a file of another model, are refused in words", () => {
    const vector = [0.5, -0.25, 0.125, 0, 0.0625]
    const back = Result.getOrThrow(decodeVector(encodeVector(vector), 5))
    expect(cosine(vector, back)).toBeGreaterThan(0.9999)
    expect(decodeVector(encodeVector(vector), 6)).toEqual(Result.fail("it holds 5 numbers, not 6"))
    expect(decodeVector("not base64!", 5)).toEqual(Result.fail("it is not base64"))
    const file = shippedFileOf([["Ana Silva has parrot Pip.", vector]])
    expect(Result.getOrThrow(shippedEntries(file)).map((entry) => entry.vector.length)).toEqual([5])
    expect(shippedEntries({ ...file, model: "another-model" })).toEqual(Result.fail(`the vectors were made by another-model, and the page embeds with ${EMBEDDER_MODEL}`))
    expect(Result.isFailure(shippedEntries({ ...file, passages: { "Ana Silva has parrot Pip.": "not base64!" } }))).toBe(true)
  })
})
