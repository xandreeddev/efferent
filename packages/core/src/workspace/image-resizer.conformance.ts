import { Cause, Effect, Exit, Option, Predicate } from "effect"
import type { Context, Scope } from "effect"
import { check, expect, fail } from "../conformance.functions.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { ImageResizer } from "../ports/image-resizer.port.js"
import { fitTarget, scaledSize } from "../domain/image-resize.entity.functions.js"
import type { ImageFitTarget } from "../domain/image-resize.entity.js"
import { imageSizeOf, mediaFromBytes } from "../domain/media.entity.functions.js"

/** A fresh adapter for each check, scoped so its temporary files can be released. @public */
export interface ImageResizerSubject {
  readonly open: () => Effect.Effect<Context.Service.Shape<typeof ImageResizer>, unknown, Scope.Scope>
}

const bytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  parts.reduce((offset, part) => { output.set(part, offset); return offset + part.length }, 0)
  return output
}
const be32 = (value: number): Uint8Array => Uint8Array.of(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
const ascii = (value: string): Uint8Array => Uint8Array.from(value, (character) => character.charCodeAt(0))
const crcTable = Array.from({ length: 256 }, (_, byte) => Array.from({ length: 8 }).reduce<number>((crc) => (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1, byte) >>> 0)
const crc32 = (input: Uint8Array): number => (input.reduce((crc, byte) => (crc >>> 8) ^ (crcTable[(crc ^ byte) & 255] ?? 0), 0xffffffff) ^ 0xffffffff) >>> 0
const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const payload = bytes(ascii(type), data)
  return bytes(be32(data.length), payload, be32(crc32(payload)))
}
const adler32 = (input: Uint8Array): number => input.reduce((state, byte) => {
  const a = ((state & 0xffff) + byte) % 65521
  const b = ((state >>> 16) + a) % 65521
  return ((b << 16) | a) >>> 0
}, 1)
const storedDeflate = (input: Uint8Array): Uint8Array => bytes(Uint8Array.of(0x78, 0x01), ...Array.from({ length: Math.ceil(input.length / 65535) }, (_, index) => {
  const data = input.subarray(index * 65535, (index + 1) * 65535)
  const length = data.length
  return bytes(Uint8Array.of((index + 1) * 65535 >= input.length ? 1 : 0, length & 255, length >>> 8, (~length) & 255, ((~length) >>> 8) & 255), data)
}), be32(adler32(input)))

/**
 * A deterministic opaque RGBA PNG fixture. Stored DEFLATE blocks, CRC32
 * chunks and Adler32 make it decodable by real backends without any host
 * or compression dependency. The pixel noise keeps byte-limit fixtures
 * from depending on a backend's optimization of a uniform image.
 *
 * @public
 */
export const imageResizerPng = (width: number, height: number): Uint8Array => {
  const stride = width * 4 + 1
  const scanlines = Uint8Array.from({ length: stride * height }, (_, offset) => {
    const column = offset % stride
    if (column === 0) return 0
    const channel = (column - 1) % 4
    if (channel === 3) return 255
    const pixel = Math.floor(offset / stride) * width + Math.floor((column - 1) / 4)
    const lane = Math.imul(pixel + 1, 0x9e3779b1)
    const noise = Math.imul(lane ^ (lane >>> 16), 0x85ebca6b)
    return (noise >>> (channel * 8)) & 255
  })
  return bytes(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk("IHDR", bytes(be32(width), be32(height), Uint8Array.of(8, 6, 0, 0, 0))), chunk("IDAT", storedDeflate(scanlines)), chunk("IEND", new Uint8Array()))
}

/**
 * The image resize contract: output is readable supported media within
 * both limits; large sides and incompressible bytes can be reduced, the
 * requested scaled size is retained with an ample byte budget, aspect is
 * kept within a pixel, smaller sources are never enlarged, and unknown
 * input fails with a typed Unsupported error. Checks each finish in 30s.
 *
 * @public
 */
export const imageResizerConformance = (subject: ImageResizerSubject): ReadonlyArray<ConformanceCheck> => {
  const resized = (id: string, source: { readonly width: number; readonly height: number }, target: ImageFitTarget, fullSide = false) => Effect.gen(function* () {
    const resizer = yield* subject.open()
    const output = yield* resizer.fit({ bytes: imageResizerPng(source.width, source.height), mediaType: "image/png" }, target)
    const media = yield* mediaFromBytes(output)
    const size = yield* Option.match(imageSizeOf(output, media.mediaType), { onNone: () => fail(id, "the output has no readable dimensions"), onSome: Effect.succeed })
    yield* expect(id, output.length <= target.maxBytes && size.width <= target.maxSide && size.height <= target.maxSide, "the output exceeds the requested byte or side limit")
    yield* expect(id, size.width <= source.width && size.height <= source.height, "the output upscaled its source")
    if (fullSide) {
      const expected = scaledSize(source, target.maxSide)
      yield* expect(id, size.width === expected.width && size.height === expected.height, "the output lost dimensions despite a generous byte target")
    }
    const scale = Math.max(size.width, size.height) / Math.max(source.width, source.height)
    yield* expect(id, Math.abs(size.width - source.width * scale) <= 1 && Math.abs(size.height - source.height * scale) <= 1, "the output changed its aspect by more than one pixel")
  })
  const resizeCheck = (name: string, id: string, body: Effect.Effect<void, unknown, Scope.Scope>): ConformanceCheck => check(name, id, () => Effect.scoped(body).pipe(
    Effect.catchDefect(() => fail(id, "the resizer died instead of returning a typed failure")),
    Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => fail(id, "the check did not finish in 30 seconds") }),
  ))
  return [
    resizeCheck("an over-limit side is reduced into readable media", "side-limit", resized("side-limit", { width: 9000, height: 10 }, fitTarget())),
    resizeCheck("an over-limit byte payload is reduced into readable media", "byte-limit", resized("byte-limit", { width: 1200, height: 1200 }, fitTarget())),
    resizeCheck("a requested smaller side preserves the image aspect", "aspect", resized("aspect", { width: 640, height: 320 }, fitTarget(200), true)),
    resizeCheck("an image below the target dimensions is never upscaled", "no-upscale", resized("no-upscale", { width: 32, height: 16 }, fitTarget(200))),
    resizeCheck("unknown bytes fail as Unsupported rather than a defect", "unsupported", Effect.gen(function* () {
      const resizer = yield* subject.open()
      const outcome = yield* Effect.exit(resizer.fit({ bytes: ascii("not an image"), mediaType: "image/png" }, fitTarget()))
      yield* Exit.match(outcome, {
        onSuccess: () => fail("unsupported", "unknown input was accepted"),
        onFailure: (cause) => expect("unsupported", !Cause.hasDies(cause) && !Cause.hasInterrupts(cause) && Option.exists(Cause.findErrorOption(cause), (error) => Predicate.isTagged(error, "ImageResizeError") && error.reason === "Unsupported"), "unknown input did not produce an Unsupported ImageResizeError"),
      })
    })),
  ]
}
