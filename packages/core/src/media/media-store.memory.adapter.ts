import { Effect, Layer, Option, Ref, Result, Schema } from "effect"
import { MediaHash, MediaStoreBytes, MediaStoreError } from "../domain/media-store.entity.js"
import { mediaHashOf } from "../domain/media-store.entity.functions.js"
import { MediaStore } from "../ports/media-store.port.js"

const invalid = (cause: Schema.SchemaError) => new MediaStoreError({ reason: "Invalid", message: "The media-store input is invalid", cause })
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index])

/** Immutable content-addressed bytes held by this layer instance. @public */
export const MediaStoreMemoryLive: Layer.Layer<MediaStore> = Layer.effect(MediaStore, Effect.gen(function* () {
  const state = yield* Ref.make<ReadonlyMap<MediaHash, Uint8Array>>(new Map())
  return MediaStore.of({
    put: Effect.fn("media_store.put")(function* (bytes) {
      // Validate and copy before the first effect can suspend. The constructor
      // also copies a Buffer/subarray whose slice method might alias its input.
      const copied = Result.map(Schema.decodeUnknownResult(MediaStoreBytes)(bytes), (bytes) => new Uint8Array(bytes))
      const input = yield* Effect.fromResult(copied).pipe(Effect.mapError(invalid))
      const hash = mediaHashOf(input)
      return yield* Ref.modify(state, (values): readonly [Effect.Effect<MediaHash, MediaStoreError>, ReadonlyMap<MediaHash, Uint8Array>] => {
        const previous = values.get(hash)
        return previous !== undefined && !sameBytes(previous, input)
          ? [Effect.fail(new MediaStoreError({ reason: "Corrupt", message: "Stored media bytes disagree with their content key" })), values]
          : [Effect.succeed(hash), previous === undefined ? new Map([...values, [hash, input]]) : values]
      }).pipe(Effect.flatten)
    }),
    get: Effect.fn("media_store.get")(function* (hash) {
      const key = yield* Schema.decodeUnknownEffect(MediaHash)(hash).pipe(Effect.mapError(invalid))
      // No stored buffer escapes this adapter: immutable content is established
      // on put, and every read owns its independent copy.
      return Option.map(Option.fromNullishOr((yield* Ref.get(state)).get(key)), (bytes) => new Uint8Array(bytes))
    }),
  })
}))
