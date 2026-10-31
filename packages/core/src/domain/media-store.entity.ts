import { Schema } from "effect"
import { MEDIA_LIMITS } from "./media.entity.js"

/** SHA-256 of decoded media bytes, independent of their labels and encoding. @public */
export const MediaHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(Schema.brand("MediaHash"))
export type MediaHash = typeof MediaHash.Type

/** The byte-store boundary; hashing itself also supports empty and larger values. @public */
export const MediaStoreBytes = Schema.Uint8Array.check(Schema.makeFilter((bytes) => {
  // The intrinsic getter bypasses subclass accessors; proxies have no native
  // typed-array storage and must be rejected before invoking it.
  const length: unknown = ArrayBuffer.isView(bytes) ? Reflect.get(Uint8Array.prototype, "byteLength", bytes) : 0
  return typeof length === "number" && Number.isFinite(length) && length > 0 && length <= MEDIA_LIMITS.imageBytes
    ? true : `media bytes must contain 1 to ${MEDIA_LIMITS.imageBytes} bytes`
}))
export type MediaStoreBytes = typeof MediaStoreBytes.Type

/** Invalid input, an unavailable backend, or stored bytes inconsistent with their key. @public */
export class MediaStoreError extends Schema.TaggedError<MediaStoreError>()("MediaStoreError", {
  reason: Schema.Literals(["Invalid", "Unavailable", "Corrupt"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
