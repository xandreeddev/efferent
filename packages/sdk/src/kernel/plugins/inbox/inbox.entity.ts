import { Schema } from "effect"
import { liveEvent, SessionId } from "@xandreed/core/kernel"

/**
 * How the inbox is set up.
 *
 * @public
 */
export interface InboxOptions {
  /** How many messages may wait behind a session's running turn before the next is refused. 64 when left out. */
  readonly capacity?: number
}

/**
 * A queued message's place in its session's queue: 1, 2, 3… in the order
 * the messages were queued, and never given twice in one inbox.
 *
 * @public
 */
export const Ticket = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("Ticket"))
export type Ticket = typeof Ticket.Type

/** A message queued for a session that its worker has not taken yet. */
export const Pending = Schema.Struct({ ticket: Ticket, message: Schema.String })
export type Pending = typeof Pending.Type

/**
 * One session's queue. `Idle`: no worker runs and nothing waits. `Working`:
 * a worker runs the session's turns one at a time, and `pending` wait
 * behind the one it runs. `next` is the ticket the next message is given.
 */
export const SessionQueue = Schema.Union([
  Schema.TaggedStruct("Idle", { next: Ticket }),
  Schema.TaggedStruct("Working", { next: Ticket, pending: Schema.Array(Pending) }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type SessionQueue = typeof SessionQueue.Type

/** The inbox: open, with a queue for every session it was given a message for; or closed with its scope. */
export const InboxState = Schema.Union([
  Schema.TaggedStruct("Open", { queues: Schema.ReadonlyMap(SessionId, SessionQueue) }),
  Schema.TaggedStruct("Closed", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type InboxState = typeof InboxState.Type

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
