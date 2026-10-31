import { MEDIA_LIMITS } from "./media.entity.js"
import type { ImageFitTarget } from "./image-resize.entity.js"

/** Provider-safe limits, clamping the requested side to whole pixels. @public */
export const fitTarget = (maxSide: number = MEDIA_LIMITS.maxPixels): ImageFitTarget => ({
  maxBytes: MEDIA_LIMITS.imageBytes,
  maxSide: Number.isFinite(maxSide) ? Math.max(1, Math.min(MEDIA_LIMITS.maxPixels, Math.floor(maxSide))) : MEDIA_LIMITS.maxPixels,
})

/** Round to whole pixels while preserving aspect to within one pixel, never enlarging either side. @public */
export const scaledSize = (size: { readonly width: number; readonly height: number }, maxSide: number): { readonly width: number; readonly height: number } => {
  const side = Number.isFinite(maxSide) ? Math.max(1, Math.floor(maxSide)) : Math.max(size.width, size.height)
  const scale = Math.min(1, side / Math.max(size.width, size.height))
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}
