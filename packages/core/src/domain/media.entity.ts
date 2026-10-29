import { Schema } from "effect"

/**
 * Images a model can be shown: a user's attachments (and, later, what a tool
 * returns). An image is stored inline in the session log, as base64, once;
 * these limits keep one image, one message and one request inside what the
 * providers accept and what a session store must hold.
 */
export const MEDIA_LIMITS = {
  /** Decoded bytes of one image: 3.75 MiB, 5 242 880 base64 characters (Anthropic's per-image limit). */
  imageBytes: 3_932_160,
  /** Pixels on either side of one image. */
  maxPixels: 8000,
  /** Attachments on one user message. */
  attachments: 8,
  /** Images one request sends as images (the rest are label lines). */
  requestImages: 8,
  /** Base64 characters of the images one request sends, and of one message's attachments together. */
  requestChars: 20_000_000,
  /** Images one tool result may carry. */
  toolResultImages: 4,
} as const

/** The image types every provider route that takes images accepts. */
export const ImageMediaType = Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"])
export type ImageMediaType = typeof ImageMediaType.Type

/**
 * A content hash of an image's decoded bytes (an FNV-1a lane and a
 * multiply-xorshift lane, 32 bits each, then the length, in hex). It names an
 * image in slots and fingerprints; it is not cryptographic.
 */
export const MediaFingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16,}$/)).pipe(Schema.brand("MediaFingerprint"))
export type MediaFingerprint = typeof MediaFingerprint.Type

/**
 * One image, inline: padded base64 `data` (no `data:` prefix) of `bytes`
 * decoded bytes, of the `mediaType` its bytes are. Build one with
 * `mediaFromBytes` or `mediaFromBase64`, which check the bytes and set the
 * type, size and fingerprint from them.
 */
export const Media = Schema.Struct({
  type: Schema.Literal("media"),
  mediaType: ImageMediaType,
  data: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(Math.ceil(MEDIA_LIMITS.imageBytes / 3) * 4), Schema.isBase64()),
  fingerprint: MediaFingerprint,
  bytes: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MEDIA_LIMITS.imageBytes)),
  /** A file name the user or tool gave it, shown in its label. */
  name: Schema.optionalKey(Schema.String),
  /** A description of the image, shown in its label. */
  alt: Schema.optionalKey(Schema.String),
})
export type Media = typeof Media.Type

/** Where an image sits inside a JSON value (a tool's encoded result): its path and what it must be. */
export const MediaSlot = Schema.Struct({
  path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
  fingerprint: MediaFingerprint,
  mediaType: ImageMediaType,
  bytes: Schema.Int,
})
export type MediaSlot = typeof MediaSlot.Type

/**
 * Why an image was refused: no bytes (`Empty`), data that is not base64
 * (`InvalidBase64`), bytes that are none of the image types
 * (`UnsupportedType`), more than `MEDIA_LIMITS.imageBytes` (`TooLarge`), a
 * side over `MEDIA_LIMITS.maxPixels` (`TooManyPixels`), a header whose size
 * cannot be read (`Unreadable`), or attachments over
 * `MEDIA_LIMITS.requestChars` together (`TooLargeTogether`). `TooMany` is
 * defensive: a `UserMessage` with more than `MEDIA_LIMITS.attachments` fails
 * its schema when it is constructed or decoded, so only a value that skipped
 * that check reaches a begin with too many.
 */
export const AttachmentRejectedReason = Schema.Literals([
  "Empty", "InvalidBase64", "UnsupportedType", "TooLarge", "TooManyPixels", "Unreadable", "TooMany", "TooLargeTogether",
])
export type AttachmentRejectedReason = typeof AttachmentRejectedReason.Type

/** An image a user message or a tool result cannot carry; `index` is the attachment's position, when it is one image's fault. */
export class AttachmentRejected extends Schema.TaggedError<AttachmentRejected>()("AttachmentRejected", {
  reason: AttachmentRejectedReason,
  index: Schema.optionalKey(Schema.Int),
  message: Schema.String,
}) {}
