import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { MEDIA_LIMITS, mediaFromBytes } from "@xandreed/core"
import { ReadResult, workspaceToolsDefaults } from "./workspace-tools.entity.js"
import { binaryRead, compactRead, fileTooLargeHint, readMedia, renderRead, toolDescriptions } from "./workspace-tools.entity.functions.js"

const ascii = (text: string): ReadonlyArray<number> => Array.from(text, (char) => char.charCodeAt(0))
const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const be16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff]
const le16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff]
const le24 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]
const le32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
const bytes = (...parts: ReadonlyArray<ReadonlyArray<number>>): Uint8Array => new Uint8Array(parts.flat())
/** A file of `size` bytes that starts with `header`, zeros after it. */
const padded = (header: Uint8Array, size: number): Uint8Array => {
  const file = new Uint8Array(size)
  file.set(header)
  return file
}

/** A PNG's signature and IHDR chunk (its size), then a few bytes. */
const png = (width: number, height: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), ascii("IHDR"), be32(width), be32(height), [8, 6, 0, 0, 0], [0, 0, 0, 0])
/** A baseline JPEG's SOI, a JFIF APP0 and the frame header (its size). */
const jpeg = (width: number, height: number) => bytes(
  [0xff, 0xd8],
  [0xff, 0xe0], be16(16), ascii("JFIF"), [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, 0xc0], be16(17), [8], be16(height), be16(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  [0xff, 0xd9],
)
/** A GIF89a's header and logical screen (its size), a two-colour table, one image of one LZW block, the trailer. */
const gif = (width: number, height: number) => bytes(
  ascii("GIF89a"), le16(width), le16(height), [0x80, 0, 0], [0, 0, 0, 0xff, 0xff, 0xff],
  [0x2c], le16(0), le16(0), le16(width), le16(height), [0], [2, 2, 0x44, 0x01, 0], [0x3b],
)
/** An extended WebP: the RIFF header and its VP8X chunk (each side less one, in 24 bits). */
const webp = (width: number, height: number) => bytes(ascii("RIFF"), le32(22), ascii("WEBP"), ascii("VP8X"), le32(10), [0, 0, 0, 0], le24(width - 1), le24(height - 1))

const read = (path: string, file: Uint8Array, readImages = true) => Effect.runSync(binaryRead(path, file, readImages))
const encode = Schema.encodeSync(ReadResult)

describe("read over a binary file", () => {
  test("a PNG is an Image whose type, size and fingerprint are its bytes', named by its path; the view sends it", () => {
    const file = png(640, 480)
    const result = read("docs/chart.png", file)
    expect(result).toEqual({ _tag: "Image", path: "docs/chart.png", image: Effect.runSync(mediaFromBytes(file, { name: "docs/chart.png" })) })
    expect(result._tag === "Image" ? [result.image.mediaType, result.image.bytes] : []).toEqual(["image/png", file.length])
    expect(readMedia(result)).toEqual(result._tag === "Image" ? [result.image] : [])
    expect(renderRead(result)).toBe(`[Image docs/chart.png (image/png, ${file.length} B).]`)
    expect(compactRead(result)).toBe(`(read docs/chart.png: image/png image, ${file.length} B)`)
    expect(encode(result)).toEqual(result)
  })

  test("a JPEG is an Image too, and the type is the bytes', not the name's", () => {
    const file = jpeg(3, 2)
    const named = read("photo.jpg", file)
    const misnamed = read("photo.png", file)
    const pngNamedJpg = read("chart.jpg", png(1, 1))
    expect(named._tag === "Image" ? named.image.mediaType : named._tag).toBe("image/jpeg")
    expect(misnamed._tag === "Image" ? misnamed.image.mediaType : misnamed._tag).toBe("image/jpeg")
    expect(pngNamedJpg._tag === "Image" ? pngNamedJpg.image.mediaType : pngNamedJpg._tag).toBe("image/png")
  })

  test("a GIF and a WebP are Images too, each with the type its bytes are", () => {
    const animation = gif(320, 200)
    const photo = webp(4000, 3000)
    expect(read("anim.gif", animation)).toEqual({ _tag: "Image", path: "anim.gif", image: Effect.runSync(mediaFromBytes(animation, { name: "anim.gif" })) })
    expect(read("photo.webp", photo)).toEqual({ _tag: "Image", path: "photo.webp", image: Effect.runSync(mediaFromBytes(photo, { name: "photo.webp" })) })
    expect([read("anim.gif", animation), read("photo.png", photo)].map((result) => result._tag === "Image" ? result.image.mediaType : result._tag)).toEqual(["image/gif", "image/webp"])
    expect(renderRead(read("anim.gif", animation))).toBe(`[Image anim.gif (image/gif, ${animation.length} B).]`)
    expect(read("tall.webp", webp(10, MEDIA_LIMITS.maxPixels + 1))).toMatchObject({ _tag: "ImageRejected", mediaType: "image/webp", reason: "TooManyPixels" })
    expect(read("tall.gif", gif(10, MEDIA_LIMITS.maxPixels + 1))).toMatchObject({ _tag: "ImageRejected", mediaType: "image/gif", reason: "TooManyPixels" })
  })

  test("an image over MEDIA_LIMITS.imageBytes is a note with its path, type, size and why, without its bytes", () => {
    const file = padded(png(100, 100), MEDIA_LIMITS.imageBytes + 1)
    const result = read("big.png", file)
    expect(result).toEqual({
      _tag: "ImageRejected", path: "big.png", mediaType: "image/png", bytes: MEDIA_LIMITS.imageBytes + 1, reason: "TooLarge",
      message: `the image has ${MEDIA_LIMITS.imageBytes + 1} bytes, more than ${MEDIA_LIMITS.imageBytes}`,
    })
    expect(readMedia(result)).toEqual([])
    expect(renderRead(result)).toBe(`[big.png is an image (image/png, 3.8 MB) that read cannot show: the image has ${MEDIA_LIMITS.imageBytes + 1} bytes, more than ${MEDIA_LIMITS.imageBytes}. To see it, make a smaller copy with bash (scaled down or recompressed) and read that.]`)
    expect(compactRead(result)).toBe("(read big.png: image/png image not shown, TooLarge)")
  })

  test("an image over MEDIA_LIMITS.maxPixels a side is a note too", () => {
    const result = read("wide.png", png(MEDIA_LIMITS.maxPixels + 1, 10))
    expect(result).toMatchObject({ _tag: "ImageRejected", path: "wide.png", mediaType: "image/png", reason: "TooManyPixels" })
    expect(renderRead(result)).toContain(`the image is ${MEDIA_LIMITS.maxPixels + 1}x10 pixels, more than ${MEDIA_LIMITS.maxPixels} a side`)
    expect(renderRead(result)).toContain("scaled down")
  })

  test("a corrupt image (a signature without a size) is a note that it may be damaged", () => {
    const result = read("broken.png", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))
    expect(result).toMatchObject({ _tag: "ImageRejected", path: "broken.png", mediaType: "image/png", bytes: 12, reason: "Unreadable" })
    expect(renderRead(result)).toBe("[broken.png is an image (image/png, 12 B) that read cannot show: the image/png header does not give the image's size. The file may be damaged or cut short.]")
  })

  test("without readImages an image is Binary, with the media type its name suggests, as any other binary file", () => {
    const file = png(1, 1)
    expect(read("chart.png", file, false)).toEqual({ _tag: "Binary", path: "chart.png", bytes: file.length, mediaType: "image/png" })
    expect(read("chart", file, false)).toEqual({ _tag: "Binary", path: "chart", bytes: file.length, mediaType: null })
    expect(read("font.woff2", bytes(ascii("wOF2"), [0, 1, 0, 0]))).toEqual({ _tag: "Binary", path: "font.woff2", bytes: 8, mediaType: "font/woff2" })
    expect(readMedia(read("chart.png", file, false))).toEqual([])
  })

  test("the read description says images are seen only with readImages", () => {
    expect(toolDescriptions(workspaceToolsDefaults).read).toContain("A PNG, JPEG, GIF or WebP image (up to 3.75 MB and 8000 pixels a side) is returned as an image you can see")
    expect(toolDescriptions({ ...workspaceToolsDefaults, readImages: false }).read).not.toContain("image")
  })

  test("the read description gives the smaller of the image limit and maxFileBytes, rounded down", () => {
    const limit = (maxFileBytes: number) => toolDescriptions({ ...workspaceToolsDefaults, maxFileBytes }).read
    expect(limit(MEDIA_LIMITS.imageBytes + 1)).toContain("(up to 3.75 MB and 8000 pixels a side)")
    expect(limit(1_048_576)).toContain("(up to 1 MB and 8000 pixels a side)")
    expect(limit(2_000_000)).toContain("(up to 1.9 MB and")
    expect(limit(1_536)).toContain("(up to 1.5 KB and")
  })

  test("a file over maxFileBytes named as an image read can show is told to read a smaller copy; any other to read parts of it", () => {
    expect(fileTooLargeHint("shots/big.PNG", true)).toBe("to see it, make a smaller copy with bash (scaled down or recompressed) and read that")
    expect(["a.jpg", "a.jpeg", "a.gif", "a.webp"].map((path) => fileTooLargeHint(path, true).startsWith("to see it"))).toEqual([true, true, true, true])
    expect(fileTooLargeHint("big.png", false)).toBe("use grep to find lines in it, or bash (head, tail, sed -n) for parts of it")
    expect(fileTooLargeHint("scan.tiff", true)).toContain("use grep")
    expect(fileTooLargeHint("server.log", true)).toContain("use grep")
  })
})
