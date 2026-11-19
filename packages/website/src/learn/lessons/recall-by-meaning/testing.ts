// What lesson 20's tests embed with, so no test loads a model: the kernel's
// recorded embedder over the vectors the page's own worker made, the world's
// memories as the page ships them (vectors.ts, decoded as Load the world
// decodes them) and the lesson's messages as recorded (recorded-queries.ts).
// A text recorded for neither is refused with `EmbedFailed`, so a test that
// claims something of the list by meaning also asserts it was not skipped.
import { Context, Effect, Layer, Result, Schema } from "effect"
import { Embedder, recordedEmbedder } from "@xandreed/sdk/kernel"
import type { Lesson } from "../../lesson.ts"
import type { EmbedderService } from "../../models/meaning.ts"
import { recallByMeaning } from "./lesson.ts"
import { RECORDED_QUERIES } from "./recorded-queries.ts"
import { decodeVector, EMBEDDER_MODEL, ShippedFile } from "./shipped.ts"
import { SHIPPED } from "./vectors.ts"

/** The shipped file, decoded. */
export const shippedFile = (): ShippedFile => Effect.runSync(Schema.decodeUnknownEffect(Schema.fromJsonString(ShippedFile))(SHIPPED))

/** A recorded query's numbers: 4-byte floats, little end first, in base64. */
const floatsOf = (text: string): ReadonlyArray<number> => {
  const bytes = Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
  return Array.from(new Float32Array(bytes.buffer))
}

/** Each memory's vector as the page's store holds it, by its text. */
export const shippedPassages = (): Readonly<Record<string, ReadonlyArray<number>>> => {
  const file = shippedFile()
  return Object.fromEntries(Object.entries(file.passages).map(([text, encoded]) => [text, Result.getOrThrow(decodeVector(encoded, file.dimension))]))
}

/** The page's embedder as a test has it: the recorded vectors, under the page's model. */
export const recordedService = (): EmbedderService => {
  const layer = recordedEmbedder({
    model: EMBEDDER_MODEL,
    vectors: { query: Object.fromEntries(Object.entries(RECORDED_QUERIES).map(([text, encoded]) => [text, floatsOf(encoded)])), passage: shippedPassages() },
  })
  return Context.get(Effect.runSync(Effect.scoped(Layer.build(layer))), Embedder)
}

/** Lesson 20 as a test runs it: "Load the embedder" loads the recorded embedder, at once. */
export const recordedLesson: Lesson = { ...recallByMeaning, meaning: { ...recallByMeaning.meaning!, embedder: async () => recordedService() } }
