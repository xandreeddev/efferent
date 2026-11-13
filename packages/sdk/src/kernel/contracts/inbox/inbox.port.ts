import { Context } from "effect"
import type { Effect } from "effect"
import type { PluginFailure, SessionId, TurnFailure } from "@xandreed/core/kernel"
import type { InboxClosed, InboxRefused, Ticket } from "./inbox.entity.js"

/**
 * What a turn the inbox runs can fail with: the session's refusals, or an error of the host's own turn.
 *
 * @public
 */
export type InboxTurnFailure = TurnFailure | PluginFailure

/**
 * What the inbox runs for each message it takes: the host's own turn, from the user's message to the answer.
 *
 * @public
 */
export type InboxTurn<R> = (session: SessionId, message: string) => Effect.Effect<string, InboxTurnFailure, R>

/**
 * A message as the inbox queued it: its ticket, and its reply, which a
 * caller may wait for, or not. Interrupting a wait for the reply does not
 * cancel the turn: the message was queued and runs.
 *
 * @public
 */
export interface Queued {
  readonly ticket: Ticket
  /** The answer of the message's turn, or that turn's failure; `InboxClosed` when the inbox closed before the turn ended. */
  readonly reply: Effect.Effect<string, InboxTurnFailure | InboxClosed>
}

/**
 * Messages queued per session and answered in order, each in a turn of its
 * own, through the host's own turn, every turn seeing the turns before it.
 * A workflow contract, in a contract folder of the sdk: core does not know it.
 * Queued messages live in the process and do not survive it.
 */
export class Inbox extends Context.Service<Inbox, {
  /** Queue a message for the session. Returns at once, in call order, with its ticket and its reply. */
  readonly enqueue: (session: SessionId, message: string) => Effect.Effect<Queued, InboxRefused>
}>()("@xandreed/sdk/kernel/Inbox") {}
