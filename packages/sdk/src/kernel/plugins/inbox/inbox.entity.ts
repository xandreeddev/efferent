import { Schema } from "effect"
import { SessionId } from "@xandreed/core/kernel"
import { Ticket } from "../../contracts/inbox/inbox.entity.js"

/**
 * How the inbox is set up.
 *
 * @public
 */
export interface InboxOptions {
  /** How many messages may wait behind a session's running turn before the next is refused. 64 when left out. */
  readonly capacity?: number
}

/** A message queued for a session that its worker has not taken yet. */
export const Pending = Schema.Struct({ ticket: Ticket, message: Schema.String })
export type Pending = typeof Pending.Type

/**
 * One session's queue, which exists while a worker runs the session's
 * turns, one at a time: `pending` wait behind the one it runs. A session
 * with no queue has no worker and nothing waiting.
 */
export const SessionQueue = Schema.Struct({ pending: Schema.Array(Pending) })
export type SessionQueue = typeof SessionQueue.Type

/**
 * The inbox: open, with the ticket the next message is given and a queue
 * for every session whose worker runs; or closed with its scope. The queues
 * are a persistent map, so a transition copies no other session's queue.
 */
export const InboxState = Schema.Union([
  Schema.TaggedStruct("Open", { next: Ticket, queues: Schema.HashMap(SessionId, SessionQueue) }),
  Schema.TaggedStruct("Closed", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type InboxState = typeof InboxState.Type
