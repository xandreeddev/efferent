import { Match, Option, Result } from "effect"
import { live } from "@xandreed/core/kernel"
import type { LiveEvent, SessionId } from "@xandreed/core/kernel"
import { inboxQueuedEvent, InboxRefused, Ticket } from "./inbox.entity.js"
import type { InboxState, Pending, SessionQueue } from "./inbox.entity.js"

/** The inbox as it is opened: no session has a queue yet. */
export const openInbox: InboxState = { _tag: "Open", queues: new Map() }

/** A session the inbox has not seen: no worker, and its first message is ticket 1. */
const fresh: SessionQueue = { _tag: "Idle", next: Ticket.make(1) }

const withQueue = (queues: ReadonlyMap<SessionId, SessionQueue>, session: SessionId, queue: SessionQueue): InboxState =>
  ({ _tag: "Open", queues: new Map([...queues, [session, queue]]) })

/** What `enqueue` decided: the inbox after it, the ticket the message was given, and whether a worker starts for the session. */
export interface Enqueued {
  readonly state: InboxState
  readonly ticket: Ticket
  readonly start: boolean
}

/**
 * Queue a message for a session. The ticket is taken in the same step that
 * queues the message, so call order is queue order. A session whose queue
 * is idle gets a worker (`start`), decided here with the queueing, so no
 * message is ever left with no worker. Refused: a session with `capacity`
 * messages waiting already (`Full`), and an inbox that closed (`Closed`).
 */
export const enqueue = (state: InboxState, session: SessionId, message: string, capacity: number): Result.Result<Enqueued, InboxRefused> =>
  Match.valueTags(state, {
    Closed: (): Result.Result<Enqueued, InboxRefused> => Result.fail(new InboxRefused({ reason: "Closed", session, message: "the inbox has closed" })),
    Open: ({ queues }): Result.Result<Enqueued, InboxRefused> => Match.valueTags(queues.get(session) ?? fresh, {
      Idle: ({ next }): Result.Result<Enqueued, InboxRefused> => Result.succeed({
        state: withQueue(queues, session, { _tag: "Working", next: Ticket.make(next + 1), pending: [{ ticket: next, message }] }),
        ticket: next,
        start: true,
      }),
      Working: ({ next, pending }): Result.Result<Enqueued, InboxRefused> => pending.length >= capacity
        ? Result.fail(new InboxRefused({ reason: "Full", session, message: `session ${session} has ${pending.length} messages waiting, as many as its queue holds` }))
        : Result.succeed({
          state: withQueue(queues, session, { _tag: "Working", next: Ticket.make(next + 1), pending: [...pending, { ticket: next, message }] }),
          ticket: next,
          start: false,
        }),
    }),
  })

/** What `take` decided: the inbox after it, and the message the worker runs next, if any. */
export interface Taken {
  readonly state: InboxState
  readonly next: Option.Option<Pending>
}

/**
 * The session's worker takes the next message, the first queued. When none
 * waits the worker stops, and the queue is idle in the same step, so a
 * message queued after it starts a worker of its own. A closed inbox gives
 * nothing.
 */
export const take = (state: InboxState, session: SessionId): Taken =>
  Match.valueTags(state, {
    Closed: (): Taken => ({ state, next: Option.none() }),
    Open: ({ queues }): Taken => Match.valueTags(queues.get(session) ?? fresh, {
      Idle: (): Taken => ({ state, next: Option.none() }),
      Working: ({ next, pending }): Taken => {
        const [first, ...rest] = pending
        return first === undefined
          ? { state: withQueue(queues, session, { _tag: "Idle", next }), next: Option.none() }
          : { state: withQueue(queues, session, { _tag: "Working", next, pending: rest }), next: Option.some(first) }
      },
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
      dropped: Array.from(queues).flatMap(([session, queue]) => Match.valueTags(queue, {
        Idle: () => [],
        Working: ({ pending }) => pending.map((waiting) => ({ session, ticket: waiting.ticket })),
      })),
    }),
  })

/** `plugin.inbox.queued`: the message was given `ticket`, about the session and no turn of it. */
export const inboxQueued = (session: SessionId, ticket: Ticket): LiveEvent => live(inboxQueuedEvent, { id: session }, { ticket })
