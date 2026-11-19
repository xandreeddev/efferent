import { Schema } from "effect"

/**
 * The most bytes a media store keeps under one key unless its options name another bound: 3,932,160 (3.75 MiB), the
 * largest image a provider takes inline (5 MiB of base64).
 *
 * @public
 */
export const MEDIA_LIMIT = 3_932_160

/**
 * What a media store keeps bytes under (ADR 0034): their SHA-256, as 64 lowercase hexadecimal digits. The same bytes
 * have the same key in every store; a key names content and grants nothing by itself.
 *
 * @public
 */
export const MediaHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(Schema.brand("MediaHash"))
export type MediaHash = typeof MediaHash.Type

/**
 * Why a store refused a put or a get: no bytes (`empty`), more than its bound (`size`), a value that is no byte array
 * of its own (`bytes`: a proxy, a buffer handed away), or a key that is no `MediaHash` (`key`).
 *
 * @public
 */
export const MediaRefusedBecause = Schema.Literals(["empty", "size", "bytes", "key"])
export type MediaRefusedBecause = typeof MediaRefusedBecause.Type

/**
 * A store refused a put or a get, and says why in words (`message`): a refused put keeps nothing, a refused key is
 * never looked for.
 *
 * @public
 */
export class MediaRefused extends Schema.TaggedError<MediaRefused>()("MediaRefused", {
  reason: MediaRefusedBecause,
  message: Schema.String,
}) {}

/**
 * The medium that holds the bytes failed: a folder that cannot be read or written, a store of another layout. `cause`,
 * when there is one, is the failure itself.
 *
 * @public
 */
export class MediaUnavailable extends Schema.TaggedError<MediaUnavailable>()("MediaUnavailable", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * What a store holds under `hash` is not the bytes of that hash (a file cut short or changed on the disk): a get never
 * gives them as if they were, and never says nothing is there. A put of the right bytes repairs it.
 *
 * @public
 */
export class MediaDamaged extends Schema.TaggedError<MediaDamaged>()("MediaDamaged", {
  hash: MediaHash,
  message: Schema.String,
}) {}
