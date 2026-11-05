import { Effect, Schema, Stream } from "effect"
import { ConversationId, SessionChannel } from "@xandreed/core"
import type { FeedPayload, FeedScope } from "./domain/feed-frame.entity.js"
import { RenderError } from "./domain/render-surface.entity.js"

const decodeId = Schema.decodeUnknownEffect(ConversationId)

/**
 * A session's live channel (`SessionChannel`) as a feed's `live` stream,
 * passed in the options of `RenderFeed.frames`
 * (`feed.frames(scope, after, project, { live })`): `threadId` names the session and `principalId` is
 * its owner, as for `SessionsJournalTailLive`, so another owner follows
 * another session and receives nothing of this one. Every payload published
 * to the session from the time the feed starts (a turn's shared transient
 * events, the host's own) goes out as a transient frame after the feed's
 * ready frame; nothing published earlier is replayed, and none of it moves
 * the resume cursor. A name that is not a session fails the feed with
 * `invalid`, a channel that cannot be reached with `unavailable`.
 *
 * @public
 */
export const sessionLive = (feed: FeedScope): Effect.Effect<Stream.Stream<FeedPayload, RenderError>, never, SessionChannel> =>
  Effect.map(Effect.service(SessionChannel), (channel) => Stream.unwrap(decodeId(feed.threadId).pipe(
    Effect.mapError(() => new RenderError({ code: "invalid", message: `not a session id: ${feed.threadId}` })),
    Effect.map((id) => channel.subscribe({ id, owner: feed.principalId }).pipe(
      Stream.mapError((error) => new RenderError({ code: "unavailable", message: error.message })),
    )),
  )))
