import { Schema } from "effect"
import { liveEvent, SessionId } from "@xandreed/core/kernel"

/**
 * A queued message's number: 1, 2, 3… in the order the inbox queued its
 * messages, whatever their sessions. One inbox never gives a ticket twice,
 * and a session's tickets grow in the order its messages were queued, with
 * gaps where another session's messages came between.
 *
 * @public
 */
export const Ticket = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("Ticket"))
export type Ticket = typeof Ticket.Type

/**
 * A message the inbox did not queue: the session's queue is full (`Full`),
 * or the inbox's scope has closed (`Closed`). Nothing of it is stored.
 *
 * @public
 */
export class InboxRefused extends Schema.TaggedError<InboxRefused>()("InboxRefused", {
  reason: Schema.Literals(["Full", "Closed"]),
  session: SessionId,
  message: Schema.String,
}) {}

/**
 * The inbox's scope closed before the turn of a queued message ended: a
 * message still waiting, or the one whose turn was running, is never
 * answered.
 *
 * @public
 */
export class InboxClosed extends Schema.TaggedError<InboxClosed>()("InboxClosed", {
  message: Schema.String,
}) {}

/**
 * The data of `plugin.inbox.queued`: the ticket the message was given.
 *
 * @public
 */
export const InboxQueuedData = Schema.Struct({ ticket: Ticket })
export type InboxQueuedData = typeof InboxQueuedData.Type

/**
 * `plugin.inbox.queued`: a message was queued for the session. Live only,
 * and about the session alone: no turn of it is open for the message yet.
 *
 * @public
 */
export const inboxQueuedEvent = liveEvent("inbox", "queued", { data: InboxQueuedData })
