// The vectors lesson 20 ships with the page: the world's memories, each
// embedded ahead by the page's own embedder (e5-small-v2, 8-bit, its worker in
// Chrome, on WebAssembly, one text a call), so a reload turns into numbers only
// your message and what the conversation keeps. A vector of 384 numbers is kept
// as 384 whole numbers from -127 to 127 and one scale, the largest number's
// size over 127: each number is its whole number times the scale. The scale's
// 4 bytes (a float, little end first) and the 384 bytes go in one text, in
// base64, under the memory's text. Load the world puts each one in the page's
// store under the key the kernel's `meaningKey` makes (the model, a line feed
// and the text), so the kernel's `has` finds it and embeds only what is new.
// The data, vectors.ts, is imported only when Load the world is pressed: no
// page carries it before.
import { Result, Schema } from "effect"
import { meaningKey } from "@xandreed/sdk/kernel"
import type { VectorEntry } from "@xandreed/sdk/kernel"

/** The model the vectors were made with: the page's embedder, whose name keys them. */
export const EMBEDDER_MODEL = "Xenova/e5-small-v2"
/** The model's files, pinned: the page's worker loads this revision, and the vectors were made with it. */
export const EMBEDDER_REVISION = "02af79985278377e65c724a76275707cb0333c70"

/** The file as it is shipped: who made the vectors, how long each is, and each memory's vector under its text. */
export const ShippedFile = Schema.Struct({
  model: Schema.String,
  revision: Schema.String,
  dimension: Schema.Number,
  passages: Schema.Record(Schema.String, Schema.String),
})
export type ShippedFile = typeof ShippedFile.Type

/** A vector as one text: its scale's 4 bytes, then a byte for each number, in base64. */
export const encodeVector = (vector: ReadonlyArray<number>): string => {
  const largest = vector.reduce((most, number) => Math.max(most, Math.abs(number)), 0)
  const scale = largest === 0 ? 1 : largest / 127
  const bytes = new Uint8Array(4 + vector.length)
  new DataView(bytes.buffer).setFloat32(0, scale, true)
  vector.forEach((number, at) => { bytes[4 + at] = Math.round(number / scale) & 0xff })
  return btoa(String.fromCharCode(...bytes))
}

/** A text `encodeVector` wrote, as numbers again, or why it is none. */
export const decodeVector = (text: string, dimension: number): Result.Result<ReadonlyArray<number>, string> => {
  const raw = Result.try({ try: () => atob(text), catch: () => "it is not base64" })
  return Result.flatMap(raw, (chars) => {
    if (chars.length !== 4 + dimension) return Result.fail(`it holds ${chars.length - 4} numbers, not ${dimension}`)
    const bytes = Uint8Array.from(chars, (char) => char.charCodeAt(0))
    const view = new DataView(bytes.buffer)
    const scale = view.getFloat32(0, true)
    if (!Number.isFinite(scale) || scale <= 0) return Result.fail("its scale is no number above 0")
    return Result.succeed(Array.from({ length: dimension }, (_, at) => view.getInt8(4 + at) * scale))
  })
}

/**
 * The file's vectors as entries for the page's store, each under the kernel's key for its text, or why they are none:
 * a file made by another model than the page's, a text the kernel cannot key, a vector that does not decode. Each
 * entry is whole: the store takes all or none.
 */
export const shippedEntries = (file: ShippedFile): Result.Result<ReadonlyArray<VectorEntry>, string> => {
  if (file.model !== EMBEDDER_MODEL) return Result.fail(`the vectors were made by ${file.model}, and the page embeds with ${EMBEDDER_MODEL}`)
  return Result.all(Object.entries(file.passages).map(([text, encoded]) =>
    Result.flatMap(meaningKey(file.model, text), (key) =>
      Result.map(Result.mapError(decodeVector(encoded, file.dimension), (why) => `the vector of "${text.slice(0, 80)}" does not decode: ${why}`), (vector) => ({ key, vector })))))
}

/** The file for vectors made by the page's embedder, each memory's text to its vector. */
export const shippedFileOf = (passages: ReadonlyArray<readonly [text: string, vector: ReadonlyArray<number>]>): ShippedFile => ({
  model: EMBEDDER_MODEL,
  revision: EMBEDDER_REVISION,
  dimension: passages[0]?.[1].length ?? 0,
  passages: Object.fromEntries(passages.map(([text, vector]) => [text, encodeVector(vector)])),
})
