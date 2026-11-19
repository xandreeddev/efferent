import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { MediaDamaged, MediaHash, MediaRefused, MediaUnavailable } from "./media.entity.js"

/**
 * A store of images and other bytes for the model (ADR 0034): bytes kept under their SHA-256 and got back, never
 * changed once kept. The host provides it: `inMemoryMedia` in a page or a test, `directoryMedia` on the Node entry.
 *
 * - `maxBytes`: the most bytes it keeps under one key (`MEDIA_LIMIT` unless its options name another).
 * - `put(bytes)`: the bytes' key (`mediaHashOf`). The bytes are copied before the store waits for anything, so a
 *   caller that changes its buffer later changes nothing kept; the same bytes put again give the same key and keep
 *   what is there. No bytes, more than `maxBytes`, or a value that is no byte array of its own, are `MediaRefused`
 *   and keep nothing.
 * - `get(hash)`: the bytes kept under the key, a copy of their own each time, or none when nothing is. A key that is
 *   no `MediaHash` is `MediaRefused` and never looked for. What is kept under a key and is not the bytes of that key
 *   (damage on a disk) is `MediaDamaged`: never given back as if it were, never said to be absent.
 *
 * A medium that fails is `MediaUnavailable`. A key names content and grants nothing by itself. `mediaStoreConformance`
 * is the contract as runnable checks.
 *
 * @public
 */
export class MediaStore extends Context.Service<MediaStore, {
  readonly maxBytes: number
  readonly put: (bytes: Uint8Array) => Effect.Effect<MediaHash, MediaRefused | MediaUnavailable>
  readonly get: (hash: MediaHash) => Effect.Effect<Option.Option<Uint8Array>, MediaRefused | MediaUnavailable | MediaDamaged>
}>()("@xandreed/sdk/MediaStore") {}
