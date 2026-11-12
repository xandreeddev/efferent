import { describe, expect, test } from "bun:test"
import { Array as Arr, HashMap, Match, Option, Order, Result } from "effect"
import { SessionId } from "@xandreed/core/kernel"
import { enqueue, finish, openInbox, take } from "./inbox.entity.functions.js"
import { Ticket } from "./inbox.entity.js"
import type { InboxState, Pending, SessionQueue } from "./inbox.entity.js"

/*
 * The inbox's three transitions, phase by phase: what each decides for a
 * session with no queue, a session whose worker runs with nothing waiting,
 * one with messages waiting, a full one, and for an inbox that closed.
 */

const ana = SessionId.make("ana")
const ben = SessionId.make("ben")
const t = Ticket.make
const open = (next: number, queues: ReadonlyArray<readonly [SessionId, SessionQueue]>): InboxState => ({ _tag: "Open", next: t(next), queues: HashMap.fromIterable(queues) })
const working = (...pending: ReadonlyArray<readonly [number, string]>): SessionQueue =>
  ({ pending: pending.map(([ticket, message]) => ({ ticket: t(ticket), message })) })

/** A state as plain data, its queues in the order of their sessions: a map is compared by what it holds. */
const plain = (state: InboxState): unknown => Match.valueTags(state, {
  Closed: () => ({ _tag: "Closed" }),
  Open: ({ next, queues }) => ({ _tag: "Open", next, queues: Arr.sort(HashMap.toEntries(queues), Order.mapInput(Order.String, ([session]: readonly [SessionId, SessionQueue]) => session)) }),
})
const plainly = <A extends { readonly state: InboxState }>(decided: A): Omit<A, "state"> & { readonly state: unknown } => ({ ...decided, state: plain(decided.state) })

describe("enqueue", () => {
  const table: ReadonlyArray<readonly [string, InboxState, Result.Result<{ readonly state: InboxState; readonly ticket: Ticket; readonly start: boolean }, never>]> = [
    ["a session the inbox has not seen: the inbox's first ticket, a queue, and a worker starts",
      openInbox, Result.succeed({ state: open(2, [[ana, working([1, "hi"])]]), ticket: t(1), start: true })],
    ["a session with no queue, after other messages: the inbox's next ticket, and a worker starts",
      open(4, []), Result.succeed({ state: open(5, [[ana, working([4, "hi"])]]), ticket: t(4), start: true })],
    ["a session whose worker runs with nothing waiting: the next ticket, at the end, and no second worker",
      open(5, [[ana, working()]]), Result.succeed({ state: open(6, [[ana, working([5, "hi"])]]), ticket: t(5), start: false })],
    ["a session with a message waiting: behind it",
      open(7, [[ana, working([6, "one"])]]), Result.succeed({ state: open(8, [[ana, working([6, "one"], [7, "hi"])]]), ticket: t(7), start: false })],
    ["another session's queue is its own, and the ticket the inbox's",
      open(3, [[ben, working([2, "x"])]]), Result.succeed({ state: open(4, [[ana, working([3, "hi"])], [ben, working([2, "x"])]]), ticket: t(3), start: true })],
  ]
  test.each(table)("%s", (_name, state, expected) => {
    expect(Result.map(enqueue(state, ana, "hi", 2), plainly)).toEqual(Result.map(expected, plainly))
  })

  test("a session with as many messages waiting as its queue holds is refused", () => {
    const full = open(7, [[ana, working([5, "one"], [6, "two"])]])
    const refused = enqueue(full, ana, "hi", 2)
    expect(Result.isFailure(refused) ? { tag: refused.failure._tag, reason: refused.failure.reason, session: refused.failure.session } : refused).toEqual({ tag: "InboxRefused", reason: "Full", session: ana })
  })

  test("a closed inbox refuses every session", () => {
    const refused = enqueue({ _tag: "Closed" }, ana, "hi", 2)
    expect(Result.isFailure(refused) ? refused.failure.reason : refused).toBe("Closed")
  })

  test("tickets follow call order and are never given twice, whatever the workers took or stopped meanwhile, across sessions", () => {
    const steps = (["one", "two", "three", "four"] as const).reduce<{ readonly state: InboxState; readonly tickets: ReadonlyArray<readonly [SessionId, number]> }>((now, message, index) => {
      const session = index === 2 ? ben : ana
      const queued = Result.getOrThrow(enqueue(now.state, session, message, 8))
      // After the first message ana's worker takes it, finds nothing more and stops: ana's queue is gone.
      const after = index === 0 ? take(take(queued.state, ana).state, ana).state : queued.state
      return { state: after, tickets: [...now.tickets, [session, queued.ticket]] }
    }, { state: openInbox, tickets: [] })
    expect(steps.tickets).toEqual([[ana, 1], [ana, 2], [ben, 3], [ana, 4]])
  })
})

describe("take", () => {
  const table: ReadonlyArray<readonly [string, InboxState, InboxState, Option.Option<Pending>]> = [
    ["the first message waiting, the rest behind it",
      open(4, [[ana, working([2, "two"], [3, "three"])]]), open(4, [[ana, working([3, "three"])]]), Option.some({ ticket: t(2), message: "two" })],
    ["nothing waiting: the worker stops, and the session's queue is gone in the same step",
      open(4, [[ana, working()], [ben, working([3, "x"])]]), open(4, [[ben, working([3, "x"])]]), Option.none()],
    ["a session with no queue: nothing",
      open(4, [[ben, working()]]), open(4, [[ben, working()]]), Option.none()],
    ["a session the inbox has not seen: nothing",
      openInbox, openInbox, Option.none()],
    ["a closed inbox: nothing",
      { _tag: "Closed" }, { _tag: "Closed" }, Option.none()],
  ]
  test.each(table)("%s", (_name, state, after, next) => {
    expect(plainly(take(state, ana))).toEqual({ state: plain(after), next })
  })

  test("a message queued after the worker stopped starts a worker of its own: none is left without one", () => {
    const stopped = take(open(4, [[ana, working()]]), ana).state
    expect(Result.map(enqueue(stopped, ana, "late", 8), (queued) => queued.start)).toEqual(Result.succeed(true))
    // And one queued before the worker looked again is taken by it: no second worker.
    const before = Result.getOrThrow(enqueue(open(4, [[ana, working()]]), ana, "late", 8))
    expect(before.start).toBe(false)
    expect(take(before.state, ana).next).toEqual(Option.some({ ticket: t(4), message: "late" }))
  })

  test("the inbox keeps nothing of a session no worker runs for: a thousand sessions served one message each leave no queue", () => {
    const sessions = Array.from({ length: 1000 }, (_, index) => SessionId.make(`s-${index}`))
    const after = sessions.reduce((state, session) => {
      const queued = Result.getOrThrow(enqueue(state, session, "hi", 8))
      return take(take(queued.state, session).state, session).state
    }, openInbox)
    expect(plain(after)).toEqual({ _tag: "Open", next: 1001, queues: [] })
  })
})

describe("finish", () => {
  test("closes the inbox and drops every message still waiting, with its session", () => {
    const finished = finish(open(4, [[ana, working([2, "two"], [3, "three"])], [SessionId.make("cy"), working()]]))
    expect(finished).toEqual({
      state: { _tag: "Closed" },
      dropped: [{ session: ana, ticket: t(2) }, { session: ana, ticket: t(3) }],
    })
  })

  test("a closed inbox stays closed and drops nothing more", () => {
    expect(finish({ _tag: "Closed" })).toEqual({ state: { _tag: "Closed" }, dropped: [] })
  })
})
