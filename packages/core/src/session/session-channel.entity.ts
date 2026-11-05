import { Schema } from "effect"
import { JsonObject } from "./session-log.entity.js"

/**
 * One live payload for a session's followers (`SessionChannel`): an event
 * name and its data as JSON. It is never stored: a follower that was not
 * subscribed when it was published never sees it.
 *
 * @public
 */
export const SessionChannelPayload = Schema.Struct({
  event: Schema.Trimmed.check(Schema.isNonEmpty()),
  data: JsonObject,
})
export type SessionChannelPayload = typeof SessionChannelPayload.Type

/**
 * The channel's transport failed: a publish or a subscription could not
 * reach it (`unavailable`). A payload a slow follower lost, or one published
 * while nobody followed, is no error.
 *
 * @public
 */
export class SessionChannelError extends Schema.TaggedError<SessionChannelError>()("SessionChannelError", {
  reason: Schema.Literals(["unavailable"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
