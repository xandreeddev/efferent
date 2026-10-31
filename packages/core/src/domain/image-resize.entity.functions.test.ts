import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import fc from "fast-check"
import { fitTarget, scaledSize } from "./image-resize.entity.functions.js"
import { MEDIA_LIMITS } from "./media.entity.js"
import { imageSizeOf, mediaFromBytes, sniffImageType } from "./media.entity.functions.js"
import { imageResizerPng } from "../workspace/image-resizer.conformance.js"

test("fitTarget clamps whole pixels to the provider's bounds", () => {
  expect([fitTarget(), fitTarget(1600.9), fitTarget(9000), fitTarget(0), fitTarget(Number.NaN), fitTarget(Infinity)])
    .toEqual([8000, 1600, 8000, 1, 8000, 8000].map((maxSide) => ({ maxSide, maxBytes: MEDIA_LIMITS.imageBytes })))
})

test("scaledSize preserves dimensions below the target and rounds downscales to pixels", () => {
  expect(scaledSize({ width: 32, height: 16 }, 200)).toEqual({ width: 32, height: 16 })
  expect(scaledSize({ width: 9000, height: 10 }, 8000)).toEqual({ width: 8000, height: 9 })
  expect(scaledSize({ width: 640, height: 320 }, 200)).toEqual({ width: 200, height: 100 })
  expect(scaledSize({ width: 1, height: 9000 }, 100)).toEqual({ width: 1, height: 100 })
})

test("property: scaled dimensions fit, never upscale and preserve aspect within a pixel", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 20000 }), fc.integer({ min: 1, max: 20000 }), fc.integer({ min: 1, max: 10000 }), (width, height, side) => {
    const output = scaledSize({ width, height }, side)
    const scale = Math.min(1, side / Math.max(width, height))
    expect(output.width).toBeGreaterThanOrEqual(1)
    expect(output.height).toBeGreaterThanOrEqual(1)
    expect(output.width).toBeLessThanOrEqual(Math.min(width, side))
    expect(output.height).toBeLessThanOrEqual(Math.min(height, side))
    expect(Math.abs(output.width - width * scale)).toBeLessThanOrEqual(1)
    expect(Math.abs(output.height - height * scale)).toBeLessThanOrEqual(1)
  }), { numRuns: 150 })
})

test("pure PNG fixtures have readable headers and fail provider limits for the intended reason", () => Effect.runPromise(Effect.gen(function* () {
  const small = imageResizerPng(32, 16)
  expect(Option.getOrThrow(sniffImageType(small))).toBe("image/png")
  expect(Option.getOrThrow(imageSizeOf(small, "image/png"))).toEqual({ width: 32, height: 16 })
  expect(yield* mediaFromBytes(small)).toMatchObject({ mediaType: "image/png", bytes: small.length })
  const wide = imageResizerPng(9000, 10)
  expect(wide.length).toBeLessThan(MEDIA_LIMITS.imageBytes)
  expect(yield* Effect.flip(mediaFromBytes(wide))).toMatchObject({ _tag: "AttachmentRejected", reason: "TooManyPixels" })
  const large = imageResizerPng(1200, 1200)
  expect(large.length).toBeGreaterThan(MEDIA_LIMITS.imageBytes)
  expect(Option.getOrThrow(imageSizeOf(large, "image/png"))).toEqual({ width: 1200, height: 1200 })
  expect(yield* Effect.flip(mediaFromBytes(large))).toMatchObject({ _tag: "AttachmentRejected", reason: "TooLarge" })
})))
