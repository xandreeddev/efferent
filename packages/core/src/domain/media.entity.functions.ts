import { Effect, Option, Schema } from "effect"
import { AttachmentRejected, ImageMediaType, MEDIA_LIMITS, MediaFingerprint } from "./media.entity.js"
import type { AttachmentRejectedReason, Media, MediaSlot } from "./media.entity.js"

/** What one image is counted as in a token estimate: its base64 is never counted as text. */
export const IMAGE_TOKEN_ESTIMATE = 1_600

/** The base64 characters `bytes` decoded bytes take, padded. */
export const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4

/** An image's size in pixels, read from its header. */
export interface ImageSize {
  readonly width: number
  readonly height: number
}

/** What a caller may say about an image besides its bytes. */
export interface MediaDescription {
  readonly name?: string
  readonly alt?: string
}

const byteAt = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0
const u16be = (bytes: Uint8Array, index: number): number => (byteAt(bytes, index) << 8) | byteAt(bytes, index + 1)
const u16le = (bytes: Uint8Array, index: number): number => byteAt(bytes, index) | (byteAt(bytes, index + 1) << 8)
const u24le = (bytes: Uint8Array, index: number): number => byteAt(bytes, index) | (byteAt(bytes, index + 1) << 8) | (byteAt(bytes, index + 2) << 16)
const u32be = (bytes: Uint8Array, index: number): number => byteAt(bytes, index) * 0x1000000 + ((byteAt(bytes, index + 1) << 16) | (byteAt(bytes, index + 2) << 8) | byteAt(bytes, index + 3))
const ascii = (text: string): ReadonlyArray<number> => Array.from(text, (char) => char.charCodeAt(0))
const startsWith = (bytes: Uint8Array, offset: number, signature: ReadonlyArray<number>): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte)

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]

/** The image type the bytes are, from their magic numbers: PNG, JPEG, GIF or WebP. */
export const sniffImageType = (bytes: Uint8Array): Option.Option<ImageMediaType> =>
  startsWith(bytes, 0, PNG) ? Option.some("image/png")
    : startsWith(bytes, 0, JPEG) ? Option.some("image/jpeg")
      : startsWith(bytes, 0, ascii("GIF87a")) || startsWith(bytes, 0, ascii("GIF89a")) ? Option.some("image/gif")
        : startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP")) ? Option.some("image/webp")
          : Option.none()

const sized = (width: number, height: number): Option.Option<ImageSize> =>
  width > 0 && height > 0 ? Option.some({ width, height }) : Option.none()

/** Start-of-frame markers: the segments that hold a JPEG's size. */
const JPEG_FRAMES: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const JPEG_MAX_SEGMENTS = 4_096

/** Walk a JPEG's segments from `offset` to its first frame header. */
const jpegSize = (bytes: Uint8Array, offset: number, segments: number): Option.Option<ImageSize> => {
  if (segments > JPEG_MAX_SEGMENTS || offset + 4 > bytes.length || byteAt(bytes, offset) !== 0xff) return Option.none()
  const marker = byteAt(bytes, offset + 1)
  if (marker === 0xff) return jpegSize(bytes, offset + 1, segments + 1)
  if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return jpegSize(bytes, offset + 2, segments + 1)
  if (JPEG_FRAMES.has(marker)) return offset + 9 <= bytes.length ? sized(u16be(bytes, offset + 7), u16be(bytes, offset + 5)) : Option.none()
  const length = u16be(bytes, offset + 2)
  return marker === 0xd9 || marker === 0xda || length < 2 ? Option.none() : jpegSize(bytes, offset + 2 + length, segments + 1)
}

const webpSize = (bytes: Uint8Array): Option.Option<ImageSize> => {
  if (bytes.length < 30) return Option.none()
  if (startsWith(bytes, 12, ascii("VP8 "))) {
    return startsWith(bytes, 23, [0x9d, 0x01, 0x2a]) ? sized(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff) : Option.none()
  }
  if (startsWith(bytes, 12, ascii("VP8L"))) {
    const [b0, b1, b2, b3] = [byteAt(bytes, 21), byteAt(bytes, 22), byteAt(bytes, 23), byteAt(bytes, 24)]
    return byteAt(bytes, 20) === 0x2f
      ? sized(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)))
      : Option.none()
  }
  return startsWith(bytes, 12, ascii("VP8X")) ? sized(1 + u24le(bytes, 24), 1 + u24le(bytes, 27)) : Option.none()
}

/** An image's size in pixels from its header (PNG IHDR, GIF screen, WebP VP8/VP8L/VP8X, JPEG frame); none when the header is not readable. */
export const imageSizeOf = (bytes: Uint8Array, mediaType: ImageMediaType): Option.Option<ImageSize> => {
  if (mediaType === "image/png") return bytes.length >= 24 && startsWith(bytes, 12, ascii("IHDR")) ? sized(u32be(bytes, 16), u32be(bytes, 20)) : Option.none()
  if (mediaType === "image/gif") return bytes.length >= 10 ? sized(u16le(bytes, 6), u16le(bytes, 8)) : Option.none()
  if (mediaType === "image/webp") return webpSize(bytes)
  return jpegSize(bytes, 2, 0)
}

const hex8 = (value: number): string => value.toString(16).padStart(8, "0")

/** FNV-1a and a multiply-xorshift lane over the bytes, then their length: a content hash, not a cryptographic one. */
export const mediaFingerprintOf = (bytes: Uint8Array): MediaFingerprint => {
  const fnv = bytes.reduce((hash, byte) => Math.imul(hash ^ byte, 0x01000193) >>> 0, 0x811c9dc5)
  const mixed = bytes.reduce((hash, byte) => {
    const product = Math.imul(hash ^ byte, 0x5bd1e995)
    return (product ^ (product >>> 15)) >>> 0
  }, 0x9747b28c)
  return MediaFingerprint.make(`${hex8(fnv)}${hex8(mixed)}${bytes.length.toString(16)}`)
}

const rejected = (reason: AttachmentRejectedReason, message: string) => new AttachmentRejected({ reason, message })

const described = (description: MediaDescription) => ({
  ...(description.name === undefined ? {} : { name: description.name }),
  ...(description.alt === undefined ? {} : { alt: description.alt }),
})

const encodeBase64 = Schema.encodeSync(Schema.Uint8ArrayFromBase64)
const decodeBase64 = Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64)

/**
 * An image from its bytes. The type is the one the bytes are (sniffed), the
 * size and fingerprint are computed, and the header must give a size of at
 * most `MEDIA_LIMITS.maxPixels` a side. Fails with `AttachmentRejected`.
 */
export const mediaFromBytes = (bytes: Uint8Array, description: MediaDescription = {}): Effect.Effect<Media, AttachmentRejected> => {
  if (bytes.length === 0) return Effect.fail(rejected("Empty", "the image has no bytes"))
  if (bytes.length > MEDIA_LIMITS.imageBytes) return Effect.fail(rejected("TooLarge", `the image has ${bytes.length} bytes, more than ${MEDIA_LIMITS.imageBytes}`))
  return Option.match(sniffImageType(bytes), {
    onNone: () => Effect.fail(rejected("UnsupportedType", "the bytes are not a PNG, JPEG, GIF or WebP image")),
    onSome: (mediaType) => Option.match(imageSizeOf(bytes, mediaType), {
      onNone: () => Effect.fail(rejected("Unreadable", `the ${mediaType} header does not give the image's size`)),
      onSome: (size) => size.width > MEDIA_LIMITS.maxPixels || size.height > MEDIA_LIMITS.maxPixels
        ? Effect.fail(rejected("TooManyPixels", `the image is ${size.width}x${size.height} pixels, more than ${MEDIA_LIMITS.maxPixels} a side`))
        : Effect.succeed<Media>({
          type: "media", mediaType, data: encodeBase64(bytes), fingerprint: mediaFingerprintOf(bytes), bytes: bytes.length, ...described(description),
        }),
    }),
  })
}

/**
 * An image from base64, as `mediaFromBytes` checks it. A `data:` URL prefix
 * and whitespace (wrapped lines) are removed first; the stored `data` is the
 * canonical padded base64 of the bytes.
 */
export const mediaFromBase64 = (data: string, description: MediaDescription = {}): Effect.Effect<Media, AttachmentRejected> => {
  const stripped = data.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "")
  if (stripped.length === 0) return Effect.fail(rejected("Empty", "the image has no data"))
  if (stripped.length > base64Length(MEDIA_LIMITS.imageBytes)) {
    return Effect.fail(rejected("TooLarge", `the image's base64 has ${stripped.length} characters, more than ${base64Length(MEDIA_LIMITS.imageBytes)}`))
  }
  return Option.match(decodeBase64(stripped), {
    onNone: () => Effect.fail(rejected("InvalidBase64", "the image's data is not base64")),
    onSome: (bytes) => mediaFromBytes(bytes, description),
  })
}

/** An image checked again from its own data: type, size and fingerprint as its bytes give them; its name and alt kept. */
export const normalizeMedia = (media: Media): Effect.Effect<Media, AttachmentRejected> =>
  mediaFromBase64(media.data, { ...(media.name === undefined ? {} : { name: media.name }), ...(media.alt === undefined ? {} : { alt: media.alt }) })

const sizeText = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/**
 * The one line that stands for an image a request or a transcript does not
 * carry: `[image omitted: image/png, 182 KB, shot.png: a chart]`.
 */
export const mediaLabel = (media: Pick<Media, "mediaType" | "bytes" | "name" | "alt">): string =>
  `[image omitted: ${[media.mediaType, sizeText(media.bytes), ...(media.name === undefined ? [] : [media.name])].join(", ")}${media.alt === undefined ? "" : `: ${media.alt}`}]`

const IMAGE_TYPES: ReadonlyArray<string> = ImageMediaType.literals

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value)

/** A cheap structural check that a value is a `Media` (no base64 or fingerprint validation). */
export const isMediaValue = (value: unknown): value is Media =>
  isRecord(value) && value.type === "media" && typeof value.mediaType === "string" && IMAGE_TYPES.includes(value.mediaType)
  && typeof value.data === "string" && typeof value.fingerprint === "string" && typeof value.bytes === "number"

const slotsAt = (value: unknown, path: ReadonlyArray<string | number>): ReadonlyArray<MediaSlot> =>
  isMediaValue(value) ? [{ path, fingerprint: value.fingerprint, mediaType: value.mediaType, bytes: value.bytes }]
    : Array.isArray(value) ? value.flatMap((item, index) => slotsAt(item, [...path, index]))
      : isRecord(value) ? Object.keys(value).sort().flatMap((key) => slotsAt(value[key], [...path, key]))
        : []

/** Every image inside a JSON value, in key-sorted order, with its path. */
export const mediaSlotsOf = (value: unknown): ReadonlyArray<MediaSlot> => slotsAt(value, [])

/**
 * The image a slot names inside a JSON value, when the value there is an
 * image with the slot's fingerprint, type and size. Compares the stored
 * fields only: an image's content is checked once, when it is written.
 */
export const mediaAt = (value: unknown, slot: MediaSlot): Option.Option<Media> =>
  slot.path.reduce((at: Option.Option<unknown>, key) => Option.flatMap(at, (current): Option.Option<unknown> =>
    typeof key === "number"
      ? Array.isArray(current) ? Option.fromNullishOr(current[key]) : Option.none()
      : isRecord(current) && Object.hasOwn(current, key) ? Option.fromNullishOr(current[key]) : Option.none()), Option.some(value)).pipe(
    Option.filter(isMediaValue),
    Option.filter((media) => media.fingerprint === slot.fingerprint && media.mediaType === slot.mediaType && media.bytes === slot.bytes),
  )

/** A tool result's images as memory records them: the slots it sends, and a label line for each image it does not. */
export interface ToolResultMedia {
  readonly slots: ReadonlyArray<MediaSlot>
  readonly labels: ReadonlyArray<string>
}

interface MediaTally extends ToolResultMedia {
  readonly fingerprints: ReadonlySet<string>
  readonly chars: number
}

const unavailable = (reason: string): string => `[image unavailable: ${reason}]`

const noTally: MediaTally = { slots: [], labels: [], fingerprints: new Set<string>(), chars: 0 }

/**
 * A tool result's images checked once, when memory writes the result (a
 * provider refuses a request with a bad image, and every later request
 * would carry it). In slot order, each slot must name an image of the
 * encoded value, its data base64 of an image whose type, size and
 * fingerprint are the ones it states (`normalizeMedia` gives them back
 * unchanged); an image that fails is an `[image unavailable: <why>]` line.
 * An image a slot already named is sent once. At most
 * `MEDIA_LIMITS.toolResultImages` images are sent, within
 * `MEDIA_LIMITS.requestChars` base64 characters together; one over that is
 * its `mediaLabel` line.
 */
export const toolResultMedia = (encoded: unknown, slots: ReadonlyArray<MediaSlot>): Effect.Effect<ToolResultMedia> =>
  Effect.reduce(slots, () => noTally, (tally, slot): Effect.Effect<MediaTally> =>
    Option.match(mediaAt(encoded, slot), {
      onNone: () => Effect.succeed({ ...tally, labels: [...tally.labels, unavailable("the result holds no such image")] }),
      onSome: (media) => tally.fingerprints.has(media.fingerprint) ? Effect.succeed(tally) : normalizeMedia(media).pipe(Effect.match({
        onFailure: (error): MediaTally => ({ ...tally, labels: [...tally.labels, unavailable(error.message)] }),
        onSuccess: (checked): MediaTally => {
          if (checked.data !== media.data || checked.fingerprint !== media.fingerprint || checked.mediaType !== media.mediaType || checked.bytes !== media.bytes) {
            return { ...tally, labels: [...tally.labels, unavailable("its type, size or fingerprint is not what its data gives; build it with mediaFromBytes")] }
          }
          const fingerprints = new Set([...tally.fingerprints, media.fingerprint])
          return tally.slots.length >= MEDIA_LIMITS.toolResultImages || tally.chars + media.data.length > MEDIA_LIMITS.requestChars
            ? { ...tally, fingerprints, labels: [...tally.labels, mediaLabel(media)] }
            : { ...tally, fingerprints, slots: [...tally.slots, slot], chars: tally.chars + media.data.length }
        },
      })),
    })).pipe(Effect.map(({ slots: sent, labels }) => ({ slots: sent, labels })))

/**
 * A JSON value with every image's `data` replaced by its fingerprint: what
 * text search, fingerprints, estimates and traces see of an image. Parts
 * without an image are returned as they are (the same objects).
 */
export const elideMediaData = (value: unknown): unknown => {
  if (isMediaValue(value)) return { ...value, data: value.fingerprint }
  if (Array.isArray(value)) {
    const mapped = value.map(elideMediaData)
    return mapped.every((item, index) => item === value[index]) ? value : mapped
  }
  if (isRecord(value)) {
    const entries = Object.keys(value).map((key) => [key, value[key], elideMediaData(value[key])] as const)
    return entries.every(([, before, after]) => before === after) ? value : Object.fromEntries(entries.map(([key, , after]) => [key, after]))
  }
  return value
}
