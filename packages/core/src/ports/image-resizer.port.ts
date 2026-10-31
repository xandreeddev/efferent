import { Context } from "effect"
import type { Effect } from "effect"
import type { ImageFitTarget, ImageInput, ImageResizeError } from "../domain/image-resize.entity.js"

/**
 * Re-encode an image to fit byte and side limits, preserving its aspect
 * within one pixel and never upscaling it. Retain the requested scaled
 * dimensions when they fit the byte budget. Output may use another supported
 * image type; callers re-check it with mediaFromBytes. Unsupported bytes,
 * an unattainable target and backend failures are ImageResizeError values.
 * imageResizerConformance is the contract as runnable checks.
 *
 * @public
 */
export class ImageResizer extends Context.Service<ImageResizer, {
  readonly fit: (image: ImageInput, target: ImageFitTarget) => Effect.Effect<Uint8Array, ImageResizeError>
}>()("@xandreed/core/ImageResizer") {}
