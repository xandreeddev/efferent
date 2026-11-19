import { Effect, Layer, Option, Ref } from "effect"
import { MEDIA_LIMIT } from "../../contracts/media/media.entity.js"
import type { MediaHash } from "../../contracts/media/media.entity.js"
import { checkedBytes, checkedKey, isBound, mediaHashOf } from "../../contracts/media/media.entity.functions.js"
import { MediaStore } from "../../contracts/media/media.port.js"

/**
 * What `inMemoryMedia` is given: `maxBytes`, the most bytes it keeps under one key (`MEDIA_LIMIT` by default).
 *
 * @public
 */
export interface InMemoryMediaOptions {
  readonly maxBytes?: number
}

/**
 * A media store in memory (ADR 0034): `MediaStore` over a map, gone when the layer's scope closes; each build is a
 * store of its own. It imports no runtime module, so a page uses it. A put copies and hashes the bytes before it
 * waits, then keeps them in one `Ref.modify` (bytes put again leave what is there); a get gives a copy. Pair it with
 * a journal kept in the process: one that outlives the process would name bytes this store no longer has. A bound
 * that is no whole number of 1 or more dies where the layer is built.
 *
 * @public
 */
export const inMemoryMedia = (options: InMemoryMediaOptions = {}): Layer.Layer<MediaStore> =>
  Layer.effect(MediaStore, Effect.gen(function* () {
    const maxBytes = options.maxBytes ?? MEDIA_LIMIT
    if (!isBound(maxBytes)) return yield* Effect.die(new Error(`inMemoryMedia: maxBytes must be a whole number of at least 1, not ${maxBytes}`))
    const kept = yield* Ref.make<ReadonlyMap<MediaHash, Uint8Array>>(new Map())
    return MediaStore.of({
      maxBytes,
      put: Effect.fn("in_memory_media.put")(function* (bytes) {
        // Checked and copied in the call itself, before the first wait.
        const copy = yield* Effect.fromResult(checkedBytes(bytes, maxBytes))
        const hash = mediaHashOf(copy)
        yield* Ref.update(kept, (now) => (now.has(hash) ? now : new Map([...now, [hash, copy]])))
        return hash
      }),
      get: Effect.fn("in_memory_media.get")(function* (hash) {
        const key = yield* Effect.fromResult(checkedKey(hash))
        return Option.map(Option.fromNullishOr((yield* Ref.get(kept)).get(key)), (bytes) => new Uint8Array(bytes))
      }),
    })
  }))
