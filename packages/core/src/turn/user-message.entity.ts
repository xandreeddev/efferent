import { Schema, SchemaTransformation } from "effect"

/**
 * What the user said to start a turn. A prompt is text sent to a model; the
 * user's message is a value of its own, and every field or parameter holding
 * it is named `userMessage`. Attachments may join `text` later.
 */
export class UserMessage extends Schema.Class<UserMessage>("UserMessage")({
  text: Schema.NonEmptyString,
}) {}

/** A `UserMessage` stored as its plain text, for records that keep a string on the wire. */
export const UserMessageFromString = Schema.String.pipe(
  Schema.decodeTo(
    UserMessage,
    SchemaTransformation.transform({
      decode: (text) => ({ text }),
      encode: (userMessage) => userMessage.text,
    }),
  ),
)
