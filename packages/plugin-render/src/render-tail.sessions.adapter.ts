import { Effect, Layer, Option, Schema, Stream } from "effect"
import { ConversationId, Sessions } from "@xandreed/core"
import type { FeedScope } from "./domain/feed-frame.entity.js"
import { RenderError } from "./domain/render-surface.entity.js"
import { JournalTail } from "./ports/render.port.js"

const decodeId = Schema.decodeUnknownEffect(ConversationId)

/**
 * The feed's journal is a session: `threadId` names it and `principalId` is
 * its owner (another owner reads nothing); each record carries its turn. Reads never write, so following
 * a session runs nothing. `changes` wakes the feed after each commit this
 * instance makes; polling covers the others.
 */
export const SessionsJournalTailLive = (options: { readonly page: number } = { page: 500 }): Layer.Layer<JournalTail, never, Sessions> =>
  Layer.effect(JournalTail, Effect.gen(function* () {
    const sessions = yield* Sessions
    const address = (feed: FeedScope) => decodeId(feed.threadId).pipe(
      Effect.map((id) => ({ id, owner: feed.principalId })),
      Effect.mapError(() => new RenderError({ code: "invalid", message: `not a session id: ${feed.threadId}` })),
    )
    return JournalTail.of({
      read: (feed, after) => address(feed).pipe(
        Effect.flatMap((session) => sessions.read(session, { after, limit: options.page }).pipe(
          Effect.mapError((error) => error._tag === "SessionMissing"
            ? new RenderError({ code: "forbidden", message: "no such session" })
            : new RenderError({ code: "storage", message: error.message })),
        )),
        Effect.map((events) => events.map((event) => ({ sequence: event.seq, kind: event.kind, data: event.data, turn: Option.getOrNull(event.turn) }))),
      ),
      changes: (feed) => Stream.unwrap(Effect.match(address(feed), {
        onFailure: () => Stream.empty,
        onSuccess: (session) => sessions.changes(session),
      })),
    })
  }))

