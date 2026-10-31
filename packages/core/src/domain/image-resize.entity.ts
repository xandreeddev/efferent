import { Schema } from "effect"
import { ImageMediaType, MEDIA_LIMITS } from "./media.entity.js"

/** Bytes to resize; the type is checked against the bytes by the adapter. @public */
export const ImageInput = Schema.Struct({ bytes: Schema.Uint8Array, mediaType: ImageMediaType })
export type ImageInput = typeof ImageInput.Type

/** A resized image must fit both limits, without enlarging its source. @public */
export const ImageFitTarget = Schema.Struct({
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEDIA_LIMITS.imageBytes })),
  maxSide: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEDIA_LIMITS.maxPixels })),
})
export type ImageFitTarget = typeof ImageFitTarget.Type

/** Why an image could not be resized. @public */
export const ImageResizeReason = Schema.Literals(["Unsupported", "CannotFit", "Failed"])
export type ImageResizeReason = typeof ImageResizeReason.Type

/** A resize failure, preserving a foreign failure as a cause rather than text. @public */
export class ImageResizeError extends Schema.TaggedError<ImageResizeError>()("ImageResizeError", {
  reason: ImageResizeReason,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
