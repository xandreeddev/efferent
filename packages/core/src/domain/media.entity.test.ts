import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import fc from "fast-check"
import {
  base64Length,
  elideMediaData,
  imageSizeOf,
  isMediaValue,
  mediaAt,
  mediaFingerprintOf,
  mediaFromBase64,
  mediaFromBytes,
  mediaLabel,
  mediaSlotsOf,
  normalizeMedia,
  sniffImageType,
} from "./media.entity.functions.js"
import { MEDIA_LIMITS, Media } from "./media.entity.js"
import type { AttachmentRejected } from "./media.entity.js"

/** A 1x1 PNG. */
const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
/** A 1x1 GIF. */
const pixelGif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

const ascii = (text: string): ReadonlyArray<number> => Array.from(text, (char) => char.charCodeAt(0))
const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const be16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff]
const le16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff]
const le24 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]
const bytes = (...parts: ReadonlyArray<ReadonlyArray<number>>): Uint8Array => new Uint8Array(parts.flat())
/** Pad a header to `size` bytes, so it reads as a whole file. */
const padded = (header: Uint8Array, size: number): Uint8Array => {
  const file = new Uint8Array(size)
  file.set(header)
  return file
}

const png = (width: number, height: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), ascii("IHDR"), be32(width), be32(height), [8, 6, 0, 0, 0], [0, 0, 0, 0])
const gif = (width: number, height: number) => bytes(ascii("GIF89a"), le16(width), le16(height), [0, 0, 0])
/** A baseline JPEG: SOI, a JFIF APP0, a fill byte, a standalone marker, then the frame header. */
const jpeg = (width: number, height: number) => bytes(
  [0xff, 0xd8],
  [0xff, 0xe0], be16(16), ascii("JFIF"), [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, 0xff, 0xd0],
  [0xff, 0xc0], be16(17), [8], be16(height), be16(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
)
const riff = (chunk: string, body: ReadonlyArray<number>) => bytes(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBP"), ascii(chunk), [body.length, 0, 0, 0], body, Array.from({ length: 16 }, () => 0))
const webpLossy = (width: number, height: number) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)])
const webpLossless = (width: number, height: number) => {
  const [w, h] = [width - 1, height - 1]
  return riff("VP8L", [0x2f, w & 0xff, ((w >>> 8) & 0x3f) | ((h & 0x03) << 6), (h >>> 2) & 0xff, (h >>> 10) & 0x0f])
}
const webpExtended = (width: number, height: number) => riff("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)])

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const rejection = (effect: Effect.Effect<Media, AttachmentRejected>) => Effect.runPromise(Effect.flip(effect)).then((error) => error.reason)

describe("sniffing and header sizes", () => {
  test("each image type is sniffed from its magic bytes; text and PDF are not images", () => {
    expect([png(1, 1), jpeg(1, 1), gif(1, 1), webpLossy(1, 1), webpLossless(1, 1), webpExtended(1, 1)].map((file) => Option.getOrNull(sniffImageType(file))))
      .toEqual(["image/png", "image/jpeg", "image/gif", "image/webp", "image/webp", "image/webp"])
    expect(Option.isNone(sniffImageType(new TextEncoder().encode("hello world")))).toBe(true)
    expect(Option.isNone(sniffImageType(new TextEncoder().encode("%PDF-1.7\n")))).toBe(true)
    expect(Option.isNone(sniffImageType(new Uint8Array()))).toBe(true)
  })

  test("each header gives its size: PNG, JPEG (past fill bytes and standalone markers), GIF and the three WebP forms", () => {
    const size = (file: Uint8Array) => Option.getOrNull(Option.flatMap(sniffImageType(file), (type) => imageSizeOf(file, type)))
    expect(size(png(640, 480))).toEqual({ width: 640, height: 480 })
    expect(size(png(70_000, 3))).toEqual({ width: 70_000, height: 3 })
    expect(size(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(size(gif(300, 200))).toEqual({ width: 300, height: 200 })
    expect(size(webpLossy(1000, 700))).toEqual({ width: 1000, height: 700 })
    expect(size(webpLossless(4000, 3000))).toEqual({ width: 4000, height: 3000 })
    expect(size(webpExtended(8000, 16_000))).toEqual({ width: 8000, height: 16_000 })
  })

  test("a header that is cut short or malformed gives no size", () => {
    expect(Option.isNone(imageSizeOf(png(1, 1).slice(0, 20), "image/png"))).toBe(true)
    expect(Option.isNone(imageSizeOf(jpeg(1, 1).slice(0, 26), "image/jpeg"))).toBe(true)
    expect(Option.isNone(imageSizeOf(bytes([0xff, 0xd8], [0xff, 0xda], be16(2)), "image/jpeg"))).toBe(true)
    expect(Option.isNone(imageSizeOf(riff("VP8 ", [0, 0, 0, 0, 0, 0, 1, 0, 1, 0]), "image/webp"))).toBe(true)
    expect(Option.isNone(imageSizeOf(png(0, 10), "image/png"))).toBe(true)
  })
})

describe("making an image", () => {
  test("from bytes: the type is the sniffed one, with its size, fingerprint, name and alt; it decodes as a Media", async () => {
    const media = await run(mediaFromBytes(png(2, 3), { name: "shot.png", alt: "a chart" }))
    expect([media.type, media.mediaType, media.bytes, media.name, media.alt]).toEqual(["media", "image/png", png(2, 3).length, "shot.png", "a chart"])
    expect(media.data.length).toBe(base64Length(media.bytes))
    expect(Schema.decodeUnknownSync(Media)(media)).toEqual(media)
    expect(isMediaValue(media)).toBe(true)
  })

  test("from base64: a data: URL prefix and wrapped lines are removed; the type comes from the bytes, not the prefix", async () => {
    const wrapped = `data:image/jpeg;base64,${pixelPng.slice(0, 40)}\r\n${pixelPng.slice(40, 76)}\n  ${pixelPng.slice(76)}`
    const media = await run(mediaFromBase64(wrapped))
    expect([media.mediaType, media.data, media.bytes]).toEqual(["image/png", pixelPng, 70])
    expect((await run(mediaFromBase64(pixelGif))).mediaType).toBe("image/gif")
  })

  test("refusals: no bytes, not base64, not an image, an unreadable header, too many pixels", async () => {
    expect(await rejection(mediaFromBytes(new Uint8Array()))).toBe("Empty")
    expect(await rejection(mediaFromBase64(" \n "))).toBe("Empty")
    expect(await rejection(mediaFromBase64("abc$"))).toBe("InvalidBase64")
    expect(await rejection(mediaFromBase64("aGVsbG8gd29ybGQ="))).toBe("UnsupportedType")
    expect(await rejection(mediaFromBytes(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ascii("not an IHDR chunk"))))).toBe("Unreadable")
    expect(await rejection(mediaFromBytes(png(MEDIA_LIMITS.maxPixels + 1, 1)))).toBe("TooManyPixels")
    expect(await rejection(mediaFromBytes(jpeg(1, MEDIA_LIMITS.maxPixels + 1)))).toBe("TooManyPixels")
    expect((await run(mediaFromBytes(webpExtended(MEDIA_LIMITS.maxPixels, MEDIA_LIMITS.maxPixels)))).mediaType).toBe("image/webp")
  })

  test("an image of exactly MEDIA_LIMITS.imageBytes is taken and decodes; one byte more is TooLarge, as bytes or as base64", async () => {
    const largest = await run(mediaFromBytes(padded(png(10, 10), MEDIA_LIMITS.imageBytes)))
    expect([largest.bytes, largest.data.length]).toEqual([MEDIA_LIMITS.imageBytes, base64Length(MEDIA_LIMITS.imageBytes)])
    expect(Option.isSome(Schema.decodeUnknownOption(Media)(largest))).toBe(true)
    const over = padded(png(10, 10), MEDIA_LIMITS.imageBytes + 1)
    expect(await rejection(mediaFromBytes(over))).toBe("TooLarge")
    expect(await rejection(mediaFromBase64(Schema.encodeSync(Schema.Uint8ArrayFromBase64)(over)))).toBe("TooLarge")
  })

  test("normalizing fixes a wrong type, size and fingerprint from the data, and keeps the name and alt", async () => {
    const right = await run(mediaFromBase64(pixelPng, { name: "pixel.png" }))
    const wrong = { ...right, mediaType: "image/gif" as const, bytes: 1, fingerprint: Schema.decodeUnknownSync(Media.fields.fingerprint)("0000000000000000") }
    expect(await run(normalizeMedia(wrong))).toEqual(right)
  })
})

describe("fingerprints and labels", () => {
  test("a fixed vector: the 1x1 PNG", async () => {
    expect(String((await run(mediaFromBase64(pixelPng))).fingerprint)).toBe("44b70f79e64f7e1446")
    expect(String(mediaFingerprintOf(new Uint8Array()))).toBe("811c9dc59747b28c0")
  })

  test("equal bytes have equal fingerprints; changing one byte changes it", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 256 }), fc.nat(), fc.integer({ min: 1, max: 255 }), (data, at, delta) => {
      const changed = Uint8Array.from(data)
      const index = at % data.length
      changed[index] = ((changed[index] ?? 0) + delta) & 0xff
      return mediaFingerprintOf(Uint8Array.from(data)) === mediaFingerprintOf(data) && mediaFingerprintOf(changed) !== mediaFingerprintOf(data)
    }))
  })

  test("a label names the type, the size, the name and the alt", () => {
    expect(mediaLabel({ mediaType: "image/png", bytes: 186_368, name: "shot.png", alt: "a chart" })).toBe("[image omitted: image/png, 182 KB, shot.png: a chart]")
    expect(mediaLabel({ mediaType: "image/jpeg", bytes: 900 })).toBe("[image omitted: image/jpeg, 900 B]")
    expect(mediaLabel({ mediaType: "image/webp", bytes: 3 * 1024 * 1024 })).toBe("[image omitted: image/webp, 3.0 MB]")
  })
})

describe("images inside JSON values", () => {
  test("slots find every image with its path; mediaAt resolves a slot only to the image it names", async () => {
    const [a, b] = [await run(mediaFromBase64(pixelPng)), await run(mediaFromBase64(pixelGif))]
    const value = { title: "two images", pages: [{ figure: a }, { figures: [b] }], note: null }
    const slots = mediaSlotsOf(value)
    expect(slots.map((slot) => [slot.path, slot.mediaType])).toEqual([[["pages", 0, "figure"], "image/png"], [["pages", 1, "figures", 0], "image/gif"]])
    expect(slots.map((slot) => Option.getOrNull(Option.map(mediaAt(value, slot), (media) => media.fingerprint)))).toEqual([a.fingerprint, b.fingerprint])
    const moved = { ...slots[0]!, fingerprint: b.fingerprint }
    expect(Option.isNone(mediaAt(value, moved))).toBe(true)
    expect(Option.isNone(mediaAt(value, { ...slots[0]!, path: ["pages", "0", "figure"] }))).toBe(true)
    expect(Option.isNone(mediaAt({ pages: [] }, slots[0]!))).toBe(true)
  })

  test("eliding replaces each image's data by its fingerprint and leaves everything else as it is", async () => {
    const image = await run(mediaFromBase64(pixelPng))
    const value = { text: "see", parts: [image, { type: "text", text: pixelPng }] }
    const elided = elideMediaData(value)
    expect(elided).toEqual({ text: "see", parts: [{ ...image, data: image.fingerprint }, { type: "text", text: pixelPng }] })
    const plain = { a: [1, { b: "c" }], d: null }
    expect(elideMediaData(plain)).toBe(plain)
  })
})
