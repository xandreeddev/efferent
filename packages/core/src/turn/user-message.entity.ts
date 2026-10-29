import { Schema } from "effect"
import { MEDIA_LIMITS, Media } from "../domain/media.entity.js"

/**
 * What the user said to start a turn. A prompt is text sent to a model; the
 * user's message is a value of its own, and every field or parameter holding
 * it is named `userMessage`. It has text, images (`attachments`, at most
 * `MEDIA_LIMITS.attachments`), or both: the text may be empty only when
 * there is an image. `Sessions.begin` checks each image's bytes and stores
 * the message as `normalizeUserMessage` gives it.
 */
export class UserMessage extends Schema.Class<UserMessage>("UserMessage")(Schema.Struct({
  text: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Media).check(Schema.isMinLength(1), Schema.isMaxLength(MEDIA_LIMITS.attachments))),
}).check(Schema.makeFilter((message) => message.text.length > 0 || message.attachments !== undefined ? true : "a user message needs text or an attachment"))) {}
