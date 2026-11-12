import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { SessionId } from "@xandreed/core/kernel"
import { enqueue, finish, openInbox, take } from "./inbox.entity.functions.js"
import { Ticket } from "./inbox.entity.js"
import type { InboxState, Pending, SessionQueue } from "./inbox.entity.js"

/*
 * The inbox's three transitions, phase by phase: what each decides for a
 * session that is idle, working with nothing waiting, working with
 * messages waiting, full, and for an inbox that closed.
 */

const ana = SessionId.make("ana")
const ben = SessionId.make("ben")
const t = Ticket.make
const open = (queues: ReadonlyArray<readonly [SessionId, SessionQueue]>): InboxState => ({ _tag: "Open", queues: new Map(queues) })
const idle = (next: number): SessionQueue => ({ _tag: "Idle", next: t(next) })
const working = (next: number, ...pending: ReadonlyArray<readonly [number, string]>): SessionQueue =>
  ({ _tag: "Working", next: t(next), pending: pending.map(([ticket, message]) => ({ ticket: t(ticket), message })) })

describe("enqueue", () => {
  const table: ReadonlyArray<readonly [string, InboxState, ReturnType<typeof enqueue>]> = [
    ["a session the inbox has not seen: ticket 1, and a worker starts",
      openInbox, Result.succeed({ state: open([[ana, working(2, [1, "hi"])]]), ticket: t(1), start: true })],
    ["an idle session: the next ticket, and a worker starts",
      open([[ana, idle(4)]]), Result.succeed({ state: open([[ana, working(5, [4, "hi"])]]), ticket: t(4), start: true })],
    ["a working session with nothing waiting: the next ticket, at the end, and no second worker",
      open([[ana, working(5)]]), Result.succeed({ state: open([[ana, working(6, [5, "hi"])]]), ticket: t(5), start: false })],
    ["a working session with a message waiting: behind it",
      open([[ana, working(7, [6, "one"])]]), Result.succeed({ state: open([[ana, working(8, [6, "one"], [7, "hi"])]]), ticket: t(7), start: false })],
    ["another session's queue is its own",
      open([[ben, working(3, [2, "x"])]]), Result.succeed({ state: open([[ben, working(3, [2, "x"])], [ana, working(2, [1, "hi"])]]), ticket: t(1), start: true })],
  ]
  test.each(table)("%s", (_name, state, expected) => {
    expect(enqueue(state, ana, "hi", 2)).toEqual(expected)
  })

  test("a session with as many messages waiting as its queue holds is refused", () => {
    const full = open([[ana, working(7, [5, "one"], [6, "two"])]])
    const refused = enqueue(full, ana, "hi", 2)
    expect(Result.isFailure(refused) ? { tag: refused.failure._tag, reason: refused.failure.reason, session: refused.failure.session } : refused).toEqual({ tag: "InboxRefused", reason: "Full", session: ana })
  })

  test("a closed inbox refuses every session", () => {
    const refused = enqueue({ _tag: "Closed" }, ana, "hi", 2)
    expect(Result.isFailure(refused) ? refused.failure.reason : refused).toBe("Closed")
  })

  test("tickets follow call order and are never given twice, whatever the worker took meanwhile", () => {
    const steps = ["one", "two", "three"].reduce<{ readonly state: InboxState; readonly tickets: ReadonlyArray<number> }>((now, message, index) => {
      const queued = Result.getOrThrow(enqueue(now.state, ana, message, 8))
      // The worker takes after the first message: the number of the next one does not depend on it.
      const after = index === 0 ? take(queued.state, ana).state : queued.state
      return { state: after, tickets: [...now.tickets, queued.ticket] }
    }, { state: openInbox, tickets: [] })
    expect(steps.tickets).toEqual([1, 2, 3])
  })
})

describe("take", () => {
  const table: ReadonlyArray<readonly [string, InboxState, InboxState, Option.Option<Pending>]> = [
    ["the first message waiting, the rest behind it",
      open([[ana, working(4, [2, "two"], [3, "three"])]]), open([[ana, working(4, [3, "three"])]]), Option.some({ ticket: t(2), message: "two" })],
    ["nothing waiting: the worker stops, and the queue is idle in the same step",
      open([[ana, working(4)]]), open([[ana, idle(4)]]), Option.none()],
    ["an idle session: nothing",
      open([[ana, idle(4)]]), open([[ana, idle(4)]]), Option.none()],
    ["a session the inbox has not seen: nothing",
      openInbox, openInbox, Option.none()],
    ["a closed inbox: nothing",
      { _tag: "Closed" }, { _tag: "Closed" }, Option.none()],
  ]
  test.each(table)("%s", (_name, state, after, next) => {
    expect(take(state, ana)).toEqual({ state: after, next })
  })

  test("a message queued after the worker stopped starts a worker of its own: none is left without one", () => {
    const stopped = take(open([[ana, working(4)]]), ana).state
    expect(Result.map(enqueue(stopped, ana, "late", 8), (queued) => queued.start)).toEqual(Result.succeed(true))
    // And one queued before the worker looked again is taken by it: no second worker.
    const before = Result.getOrThrow(enqueue(open([[ana, working(4)]]), ana, "late", 8))
    expect(before.start).toBe(false)
    expect(take(before.state, ana).next).toEqual(Option.some({ ticket: t(4), message: "late" }))
  })
})

describe("finish", () => {
  test("closes the inbox and drops every message still waiting, with its session", () => {
    expect(finish(open([[ana, working(4, [2, "two"], [3, "three"])], [ben, idle(9)], [SessionId.make("cy"), working(2)]]))).toEqual({
      state: { _tag: "Closed" },
      dropped: [{ session: ana, ticket: t(2) }, { session: ana, ticket: t(3) }],
    })
  })

  test("a closed inbox stays closed and drops nothing more", () => {
    expect(finish({ _tag: "Closed" })).toEqual({ state: { _tag: "Closed" }, dropped: [] })
  })
})
