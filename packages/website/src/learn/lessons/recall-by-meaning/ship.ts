// Load the world's second half on lesson 20's page: the vectors made ahead for the world's memories, decoded and put
// in the page's store, each under the kernel's key for its text. This module, with the vectors and their codec, is
// imported only when Load the world is pressed: no page carries it before.
import { Effect, Schema } from "effect"
import { VectorStore } from "@xandreed/sdk/kernel"
import { ShippedFile, shippedEntries } from "./shipped.ts"
import { SHIPPED } from "./vectors.ts"

/** What was put, in words, or why nothing was. */
export const shipVectors: Effect.Effect<string, string, VectorStore> = Effect.gen(function* () {
  const file = yield* Effect.mapError(Schema.decodeUnknownEffect(Schema.fromJsonString(ShippedFile))(SHIPPED), () => "the world's vectors are not in the shape the page reads.")
  const entries = yield* Effect.fromResult(shippedEntries(file))
  const store = yield* VectorStore
  yield* Effect.mapError(store.put(entries), (failed) => `the page's store refused the world's vectors: ${failed.message}`)
  return `Put ${entries.length} vectors in the page's store, made ahead by the page's embedder, one for each memory's text: a message is the only text turned into numbers when you ask.`
})
