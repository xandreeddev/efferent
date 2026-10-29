import { Effect } from "effect"
import { AttachmentRejected, MEDIA_LIMITS } from "../domain/media.entity.js"
import type { Media } from "../domain/media.entity.js"
import { mediaLabel, normalizeMedia } from "../domain/media.entity.functions.js"
import { UserMessage } from "./user-message.entity.js"

/** The message's images, in order (none for a text-only message). */
export const attachmentsOf = (message: UserMessage): ReadonlyArray<Media> => message.attachments ?? []

/**
 * The message as one text, for transcripts, digests and ledgers: its text,
 * then one `mediaLabel` line per image. A text-only message is its text.
 */
export const userMessageText = (message: UserMessage): string =>
  [message.text, ...attachmentsOf(message).map(mediaLabel)].filter((line) => line.length > 0).join("\n")

const sameMedia = (left: Media, right: Media): boolean =>
  left.fingerprint === right.fingerprint && left.mediaType === right.mediaType && left.bytes === right.bytes
  && left.name === right.name && left.alt === right.alt

/** The same message: equal text and the same images (by fingerprint, type, size, name and alt), in order. */
export const sameUserMessage = (left: UserMessage, right: UserMessage): boolean => {
  const [a, b] = [attachmentsOf(left), attachmentsOf(right)]
  return left.text === right.text && a.length === b.length && a.every((media, index) => {
    const other = b[index]
    return other !== undefined && sameMedia(media, other)
  })
}

/**
 * The message with each image checked again from its own bytes
 * (`normalizeMedia`: type, size and fingerprint as the bytes give them), and
 * the images together within `MEDIA_LIMITS.requestChars`. A text-only
 * message is returned as it is. `Sessions.begin` stores what this returns,
 * and compares a retried key against it.
 */
export const normalizeUserMessage = (message: UserMessage): Effect.Effect<UserMessage, AttachmentRejected> => {
  const attachments = attachmentsOf(message)
  if (attachments.length === 0) return Effect.succeed(message)
  if (attachments.length > MEDIA_LIMITS.attachments) {
    return Effect.fail(new AttachmentRejected({ reason: "TooMany", message: `${attachments.length} attachments, more than ${MEDIA_LIMITS.attachments}` }))
  }
  return Effect.forEach(attachments, (media, index) => normalizeMedia(media).pipe(
    Effect.mapError((error) => new AttachmentRejected({ reason: error.reason, index, message: `attachment ${index}: ${error.message}` })),
  )).pipe(Effect.flatMap((normalized) => {
    const chars = normalized.reduce((sum, media) => sum + media.data.length, 0)
    return chars > MEDIA_LIMITS.requestChars
      ? Effect.fail(new AttachmentRejected({ reason: "TooLargeTogether", message: `the attachments take ${chars} base64 characters together, more than ${MEDIA_LIMITS.requestChars}` }))
      : Effect.succeed(new UserMessage({ text: message.text, attachments: normalized }))
  }))
}
