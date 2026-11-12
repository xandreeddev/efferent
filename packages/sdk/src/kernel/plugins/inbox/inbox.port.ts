import { Context } from "effect"
import type { Effect } from "effect"
import type { LoopFailure, Reply, SessionId } from "@xandreed/core/kernel"
import type { InboxClosed, InboxRefused, Ticket } from "./inbox.entity.js"

/**
 * A message as the inbox queued it: its ticket, and its reply, which a
 * caller may wait for, or not. Interrupting a wait for the reply does not
 * cancel the turn: the message was queued and runs.
 *
 * @public
 */
export interface Queued {
  readonly ticket: Ticket
  /** The reply of the message's turn, or that turn's failure; `InboxClosed` when the inbox closed before the turn ended. */
  readonly reply: Effect.Effect<Reply, LoopFailure | InboxClosed>
}

/**
 * Messages queued per session and answered in order, each in a turn of its
 * own, every turn seeing the turns before it. A contract of the inbox
 * plugin's own, declared in its folder: core does not know it. Queued
 * messages live in the process and do not survive it.
 */
export class Inbox extends Context.Service<Inbox, {
  /** Queue a message for the session. Returns at once, in call order, with its ticket and its reply. */
  readonly enqueue: (session: SessionId, message: string) => Effect.Effect<Queued, InboxRefused>
}>()("@xandreed/sdk/kernel/Inbox") {}
