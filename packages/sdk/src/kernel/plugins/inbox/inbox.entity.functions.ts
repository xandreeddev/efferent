import { HashMap, Match, Option, Result } from "effect"
import { live } from "@xandreed/core/kernel"
import type { LiveEvent, SessionId } from "@xandreed/core/kernel"
import { inboxQueuedEvent, InboxRefused, Ticket } from "../../contracts/inbox/inbox.entity.js"
import type { InboxState, Pending } from "./inbox.entity.js"

/** The inbox as it is opened: no session has a queue yet, and the first message is ticket 1. */
export const openInbox: InboxState = { _tag: "Open", next: Ticket.make(1), queues: HashMap.empty() }

/** What `enqueue` decided: the inbox after it, the ticket the message was given, and whether a worker starts for the session. */
export interface Enqueued {
  readonly state: InboxState
  readonly ticket: Ticket
  readonly start: boolean
}

/**
 * Queue a message for a session. The ticket is the inbox's next, taken in
 * the same step that queues the message, so call order is queue order. A
 * session with no queue gets one and a worker (`start`), decided here with
 * the queueing, so no message is ever left with no worker. Refused: a
 * session with `capacity` messages waiting already (`Full`), and an inbox
 * that closed (`Closed`).
 */
export const enqueue = (state: InboxState, session: SessionId, message: string, capacity: number): Result.Result<Enqueued, InboxRefused> =>
  Match.valueTags(state, {
    Closed: (): Result.Result<Enqueued, InboxRefused> => Result.fail(new InboxRefused({ reason: "Closed", session, message: "the inbox has closed" })),
    Open: ({ next, queues }): Result.Result<Enqueued, InboxRefused> => {
      const queued = (pending: ReadonlyArray<Pending>, start: boolean): Result.Result<Enqueued, InboxRefused> => Result.succeed({
        state: { _tag: "Open", next: Ticket.make(next + 1), queues: HashMap.set(queues, session, { pending: [...pending, { ticket: next, message }] }) },
        ticket: next,
        start,
      })
      return Option.match(HashMap.get(queues, session), {
        onNone: () => queued([], true),
        onSome: ({ pending }) => pending.length >= capacity
          ? Result.fail(new InboxRefused({ reason: "Full", session, message: `session ${session} has ${pending.length} messages waiting, as many as its queue holds` }))
          : queued(pending, false),
      })
    },
  })

/** What `take` decided: the inbox after it, and the message the worker runs next, if any. */
export interface Taken {
  readonly state: InboxState
  readonly next: Option.Option<Pending>
}

/**
 * The session's worker takes the next message, the first queued. When none
 * waits the worker stops, and the session's queue is gone in the same step,
 * so a message queued after it starts a worker of its own and the inbox
 * keeps nothing of a session no worker runs for. A closed inbox gives
 * nothing.
 */
export const take = (state: InboxState, session: SessionId): Taken =>
  Match.valueTags(state, {
    Closed: (): Taken => ({ state, next: Option.none() }),
    Open: ({ next, queues }): Taken => Option.match(HashMap.get(queues, session), {
      onNone: (): Taken => ({ state, next: Option.none() }),
      onSome: ({ pending: [first, ...rest] }): Taken => first === undefined
        ? { state: { _tag: "Open", next, queues: HashMap.remove(queues, session) }, next: Option.none() }
        : { state: { _tag: "Open", next, queues: HashMap.set(queues, session, { pending: rest }) }, next: Option.some(first) },
    }),
  })

/** What `finish` decided: the closed inbox, and every message that was still waiting, with its session. */
export interface Finished {
  readonly state: InboxState
  readonly dropped: ReadonlyArray<{ readonly session: SessionId; readonly ticket: Ticket }>
}

/** The inbox closes with its scope: every message still waiting is dropped, and nothing is queued or taken after. */
export const finish = (state: InboxState): Finished =>
  Match.valueTags(state, {
    Closed: (): Finished => ({ state, dropped: [] }),
    Open: ({ queues }): Finished => ({
      state: { _tag: "Closed" },
      dropped: HashMap.toEntries(queues).flatMap(([session, { pending }]) => pending.map((waiting) => ({ session, ticket: waiting.ticket }))),
    }),
  })

/** `plugin.inbox.queued`: the message was given `ticket`, about the session and no turn of it. */
export const inboxQueued = (session: SessionId, ticket: Ticket): LiveEvent => live(inboxQueuedEvent, { id: session }, { ticket })
