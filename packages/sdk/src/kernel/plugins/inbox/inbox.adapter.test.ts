import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Scheduler, Schema, Scope, Stream } from "effect"
import type { AiError, Response } from "effect/ai"
import { Core, inspectionOf, listenerFailedEvent, Sessions, turnEndedEvent, turnStartedEvent } from "@xandreed/core/kernel"
import type { KernelEvent } from "@xandreed/core/kernel"
import type { Settings } from "../../contracts/loop/settings.port.js"
import type { SessionsOptions } from "../../index.js"
import { answer, inOrder, modelDown, scripted, stack } from "../../testing.js"
import { inboxOf } from "./inbox.adapter.js"
import { inboxQueuedEvent } from "../../contracts/inbox/inbox.entity.js"
import { Inbox } from "../../contracts/inbox/inbox.port.js"

class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {}

/** A plugin whose one waiting listener of `plugin.inbox.queued` runs `handle` with the ticket. */
const onQueued = <E>(handle: (ticket: number) => Effect.Effect<void, E>) =>
  Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(inboxQueuedEvent, (event) => handle(event.data.ticket), { name: "queued", wait: true })))

const FIVE = ["core.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.loop.assistant.message", "core.session.turn.ended"]

/**
 * The stock stack with the inbox on top, built in the scope it is run in,
 * over a model that answers call `n` (from 0) with `answerOf(n)`: the
 * inbox, `Core`, a session, what the model was sent, the names its journal
 * holds, how each of its turns ended, and its state.
 */
const inboxOver = (
  answerOf: (call: number) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>,
  options: { readonly capacity?: number; readonly sessions?: SessionsOptions; readonly extras?: Layer.Layer<never, never, Core | Settings> } = {},
) => Effect.gen(function* () {
  const { model, received } = yield* scripted(answerOf)
  const parts = { ...(options.sessions === undefined ? {} : { sessions: options.sessions }), ...(options.extras === undefined ? {} : { extras: options.extras }) }
  const built = yield* Layer.build(inboxOf(options.capacity === undefined ? {} : { capacity: options.capacity }).pipe(Layer.provideMerge(stack(model, parts))))
  const sessions = Context.get(built, Sessions)
  const session = yield* sessions.create({ owner: "learner" })
  const journal = Effect.map(sessions.read(session), (read) => read.events)
  return {
    inbox: Context.get(built, Inbox),
    core: Context.get(built, Core),
    sessions,
    session,
    received,
    names: Effect.map(journal, (events) => events.map((event): string => event.name)),
    ends: Effect.map(journal, (events) => events.filter((event) => event.name === turnEndedEvent.name).map((event) => event.data)),
    state: Effect.flatMap(sessions.read(session), (read) => Effect.map(Effect.fromResult(inspectionOf(read)), (inspection) => inspection.state)),
  }
})

/** A model's answer held until `go` is let go, after it says, through `asked`, that it was asked. */
const held = (asked: Deferred.Deferred<void>, go: Deferred.Deferred<void>, ...pieces: ReadonlyArray<string>): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.unwrap(Effect.as(Effect.andThen(Deferred.succeed(asked, undefined), Deferred.await(go)), answer(...pieces)))

/** Every test gives itself five seconds: code that waits on what never comes fails here and does not hang the run. */
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.timeout("5 seconds")))

describe("the inbox", () => {
  test("answers in order, each message in a turn of its own, with tickets 1, 2, 3; a failed turn fails its own reply and the next runs", async () => {
    const result = await run(Effect.gen(function* () {
      const announced = yield* Ref.make<ReadonlyArray<KernelEvent>>([])
      const heard = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(inboxQueuedEvent, (event) => Ref.update(announced, (all) => [...all, event]), { name: "heard", wait: true })))
      const kit = yield* inboxOver((call) => call === 1 ? Stream.fail(modelDown) : answer(`Reply ${call + 1}.`), { extras: heard })
      const queued = yield* Effect.forEach(["One", "Two", "Three"], (message) => kit.inbox.enqueue(kit.session, message), { concurrency: 1 })
      const replies = yield* Effect.forEach(queued, (entry) => Effect.result(entry.reply), { concurrency: "unbounded" })
      return { session: kit.session, announced: yield* Ref.get(announced), tickets: queued.map((entry) => Number(entry.ticket)), replies, ends: yield* kit.ends, received: yield* kit.received }
    }))
    expect(result.tickets).toEqual([1, 2, 3])
    // Each message was announced as it was queued, live, about the session and no turn of it.
    expect(result.announced).toEqual([1, 2, 3].map((ticket) => ({ _tag: "Live", session: result.session, name: inboxQueuedEvent.name, data: { ticket } })))
    expect(result.replies.map((reply) => reply._tag === "Success" ? reply.success.text : reply.failure._tag)).toEqual(["Reply 1.", "AiError", "Reply 3."])
    expect(result.ends).toEqual([
      { turn: 1, outcome: { _tag: "Completed" } },
      { turn: 2, outcome: { _tag: "Failed", reason: expect.stringContaining("AiError") } },
      { turn: 3, outcome: { _tag: "Completed" } },
    ])
    // The third turn saw the first one, and the second's message.
    expect(result.received.at(-1)?.map((message) => message.text)).toEqual(["You are a friendly tutor.", "One", "Reply 1.", "Two", "Three"])
  })

  test("refuses a message once its session's queue is full, nothing of it stored, and answers the ones it queued", async () => {
    const result = await run(Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const kit = yield* inboxOver((call) => call === 0 ? held(asked, go, "First.") : answer("Next."), { capacity: 1 })
      const first = yield* kit.inbox.enqueue(kit.session, "One")
      yield* Deferred.await(asked)                       // the first is running: it waits in no queue
      const second = yield* kit.inbox.enqueue(kit.session, "Two")
      const refused = yield* Effect.flip(kit.inbox.enqueue(kit.session, "Three"))
      // Another session's queue is its own.
      const other = yield* kit.sessions.create({ owner: "learner" })
      const elsewhere = yield* kit.inbox.enqueue(other, "Elsewhere")
      yield* Deferred.succeed(go, undefined)
      return { refused, replies: [yield* first.reply, yield* second.reply, yield* elsewhere.reply], names: yield* kit.names, received: yield* kit.received }
    }))
    expect(result.refused).toMatchObject({ _tag: "InboxRefused", reason: "Full" })
    expect(result.replies).toEqual([{ text: "First." }, { text: "Next." }, { text: "Next." }])
    expect(result.names).toEqual([...FIVE, ...FIVE])
    expect(result.received.flat().map((message) => message.text)).not.toContain("Three")
  })

  test("a worker stops when nothing waits and starts again for the next message: twenty rounds, no message lost", async () => {
    const result = await run(Effect.gen(function* () {
      const kit = yield* inboxOver((call) => answer(`Reply ${call + 1}.`))
      // Each message is queued after the reply before it: the worker either stopped or is about to look again. Every other
      // round yields first, so both cases come up.
      const replies = yield* Effect.forEach(Array.from({ length: 20 }, (_, index) => index), (index) => Effect.gen(function* () {
        if (index % 2 === 1) yield* Effect.yieldNow
        const entry = yield* kit.inbox.enqueue(kit.session, `Message ${index + 1}`)
        return { ticket: Number(entry.ticket), reply: (yield* entry.reply).text }
      }), { concurrency: 1 })
      return { replies, names: yield* kit.names, state: yield* kit.state }
    }))
    expect(result.replies).toEqual(Array.from({ length: 20 }, (_, index) => ({ ticket: index + 1, reply: `Reply ${index + 1}.` })))
    expect(result.names).toEqual(Array.from({ length: 20 }, () => FIVE).flat())
    expect(result.state).toEqual({ _tag: "Free", turns: 20 })
  })

  test("fails every reply not given yet with InboxClosed when its scope closes, the running turn's too, and refuses a message after", async () => {
    const result = await run(Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const kit = yield* inboxOver((call) => call === 0 ? held(asked, never, "Never.") : answer("Never either.")).pipe(Scope.provide(scope))
      const queued = yield* Effect.forEach(["One", "Two", "Three"], (message) => kit.inbox.enqueue(kit.session, message), { concurrency: 1 })
      yield* Deferred.await(asked)
      yield* Scope.close(scope, Exit.void)
      const replies = yield* Effect.forEach(queued, (entry) => Effect.flip(entry.reply), { concurrency: "unbounded" })
      return { replies: replies.map((failure) => failure._tag), after: yield* Effect.flip(kit.inbox.enqueue(kit.session, "Late")) }
    }))
    expect(result.replies).toEqual(["InboxClosed", "InboxClosed", "InboxClosed"])
    expect(result.after).toMatchObject({ _tag: "InboxRefused", reason: "Closed" })
  })

  test("an interrupted wait for a reply does not cancel the turn: the message was queued and runs", async () => {
    const result = await run(Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const kit = yield* inboxOver((call) => call === 0 ? held(asked, go, "Done anyway.") : answer("Next."))
      const entry = yield* kit.inbox.enqueue(kit.session, "One")
      const waiter = yield* Effect.forkChild(entry.reply)
      yield* Deferred.await(asked)
      yield* Fiber.interrupt(waiter)
      yield* Deferred.succeed(go, undefined)
      const next = yield* kit.inbox.enqueue(kit.session, "Two")
      return { next: yield* next.reply, first: yield* entry.reply, ends: yield* kit.ends }
    }))
    expect(result.first).toEqual({ text: "Done anyway." })
    expect(result.next).toEqual({ text: "Next." })
    expect(result.ends).toEqual([{ turn: 1, outcome: { _tag: "Completed" } }, { turn: 2, outcome: { _tag: "Completed" } }])
  })

  test("an enqueue interrupted while a waiting listener holds its announcement still returns its ticket, and the message is answered once", async () => {
    const result = await run(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const kit = yield* inboxOver((call) => answer(`Reply ${call + 1}.`), { extras: onQueued(() => Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go))) })
      const caller = yield* Effect.forkChild(kit.inbox.enqueue(kit.session, "One"), { startImmediately: true })
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(caller)
      const exit = yield* Fiber.await(caller)
      yield* Deferred.succeed(go, undefined)
      if (Exit.isFailure(exit)) return { returned: false }
      return { returned: true, ticket: Number(exit.value.ticket), reply: yield* exit.value.reply, calls: (yield* kit.received).length, names: yield* kit.names }
    }))
    expect(result).toEqual({ returned: true, ticket: 1, reply: { text: "Reply 1." }, calls: 1, names: FIVE })
  })

  test("plugin.inbox.queued reaches a waiting listener that suspends before its message's turn starts, on a session whose worker runs", async () => {
    const result = await run(Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const enteredTwo = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const startedTwo = yield* Deferred.make<void>()
      const lines = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (line: string) => Ref.update(lines, (all) => [...all, line])
      // The second message's announcement is held until the test lets it go, or until its turn has started: a turn that
      // starts first is written down before it.
      const queued = onQueued((ticket) => ticket === 2
        ? Effect.andThen(Deferred.succeed(enteredTwo, undefined), Effect.raceFirst(Deferred.await(go), Deferred.await(startedTwo))).pipe(Effect.andThen(note("queued 2")))
        : note(`queued ${ticket}`))
      const started = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(turnStartedEvent, (event) =>
        Effect.andThen(note(`started ${event.data.turn}`), event.data.turn === 2 ? Deferred.succeed(startedTwo, undefined) : Effect.void), { name: "turns", wait: true })))
      const kit = yield* inboxOver((call) => call === 0 ? held(asked, release, "First.") : answer("Second."), { extras: inOrder(queued, started) })
      const first = yield* kit.inbox.enqueue(kit.session, "One")
      yield* Deferred.await(asked)                       // the session's worker runs the first turn
      const second = yield* Effect.forkChild(kit.inbox.enqueue(kit.session, "Two"))
      yield* Deferred.await(enteredTwo)
      yield* Deferred.succeed(release, undefined)        // the first turn ends, and the worker looks for the next message
      const replies = [yield* first.reply]
      yield* Deferred.succeed(go, undefined)
      replies.push(yield* (yield* Fiber.join(second)).reply)
      return { replies, lines: yield* Ref.get(lines) }
    }))
    expect(result.replies).toEqual([{ text: "First." }, { text: "Second." }])
    expect(result.lines).toEqual(["queued 1", "started 1", "queued 2", "started 2"])
  })

  test("a waiting listener of plugin.inbox.queued that fails does not fail the queueing: the message is answered, and the failure reported", async () => {
    const result = await run(Effect.gen(function* () {
      const reported = yield* Deferred.make<unknown>()
      const reporter = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event.data), { name: "reports" })))
      const kit = yield* inboxOver((call) => answer(`Reply ${call + 1}.`), { extras: inOrder(onQueued(() => Effect.fail(new Refused({ message: "not now" }))), reporter) })
      const queued = yield* kit.inbox.enqueue(kit.session, "One")
      return { ticket: Number(queued.ticket), reply: yield* queued.reply, report: yield* Deferred.await(reported), names: yield* kit.names }
    }))
    expect(result).toEqual({ ticket: 1, reply: { text: "Reply 1." }, report: { listener: "queued", event: inboxQueuedEvent.name, reason: "Refused: not now" }, names: FIVE })
  })

  test("a waiting listener of plugin.inbox.queued that fails holds back none after it: the next one hears the message", async () => {
    const result = await run(Effect.gen(function* () {
      const heard = yield* Ref.make<ReadonlyArray<number>>([])
      const kit = yield* inboxOver((call) => answer(`Reply ${call + 1}.`), {
        extras: inOrder(onQueued(() => Effect.fail(new Refused({ message: "not now" }))), onQueued((ticket) => Ref.update(heard, (all) => [...all, ticket]))),
      })
      const queued = yield* kit.inbox.enqueue(kit.session, "One")
      return { reply: yield* queued.reply, heard: yield* Ref.get(heard) }
    }))
    expect(result).toEqual({ reply: { text: "Reply 1." }, heard: [1] })
  })

  test("fails the reply of a message whose announcement is held when the scope closes, and starts no turn for it", async () => {
    const result = await run(Effect.gen(function* () {
      const enteredTwo = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      // The second message's announcement never ends: after the first turn, the worker waits for it.
      const kit = yield* inboxOver((call) => answer(`Reply ${call + 1}.`), { extras: onQueued((ticket) => ticket === 2 ? Effect.andThen(Deferred.succeed(enteredTwo, undefined), Deferred.await(never)) : Effect.void) }).pipe(Scope.provide(scope))
      const first = yield* kit.inbox.enqueue(kit.session, "One")
      const second = yield* Effect.forkChild(kit.inbox.enqueue(kit.session, "Two"))
      yield* Deferred.await(enteredTwo)
      const reply = yield* first.reply
      yield* Scope.close(scope, Exit.void)
      const queued = yield* Fiber.await(second)
      const late = Exit.isSuccess(queued) ? yield* Effect.flip(queued.value.reply) : undefined
      return { reply, late: late?._tag, calls: (yield* kit.received).length, names: yield* kit.names }
    }))
    expect(result).toEqual({ reply: { text: "Reply 1." }, late: "InboxClosed", calls: 1, names: FIVE })
  })

  test("announces one session's messages in ticket order, whichever announcement a waiting listener holds", async () => {
    const result = await run(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const heard = yield* Ref.make<ReadonlyArray<number>>([])
      // The first announcement is held; the second's listener would write down its ticket at once.
      const kit = yield* inboxOver((call) => answer(`Reply ${call + 1}.`), {
        extras: onQueued((ticket) => Effect.andThen(ticket === 1 ? Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)) : Effect.void, Ref.update(heard, (all) => [...all, ticket]))),
      })
      const queued = yield* Effect.forEach(["One", "Two"], (message) => kit.inbox.enqueue(kit.session, message), { concurrency: 1 })
      yield* Deferred.await(entered)
      yield* Deferred.succeed(go, undefined)
      const replies = yield* Effect.forEach(queued, (entry) => entry.reply, { concurrency: 1 })
      return { replies, heard: yield* Ref.get(heard) }
    }))
    expect(result).toEqual({ replies: [{ text: "Reply 1." }, { text: "Reply 2." }], heard: [1, 2] })
  })

  /*
   * The worker takes a message and waits for its announcement; a message is
   * queued while turns run. A scheduler that makes every fiber yield after a
   * few operations lets the queueing land anywhere in the worker's steps, so
   * a take that waited for an announcement other than its message's own, or
   * an announcement chained to a message that is no longer waiting, shows.
   */
  const budgets = Array.from({ length: 40 }, (_, index) => index + 4)
  const tickets = [1, 2, 3, 4, 5, 6, 7, 8]

  test("a message's announcement reaches the listeners the publisher waits for before its turn starts, and announcements come in ticket order, wherever the worker is preempted", async () => {
    const results = await run(Effect.forEach(budgets, (budget) => Effect.scoped(Effect.gen(function* () {
      const lines = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (line: string) => Ref.update(lines, (all) => [...all, line])
      // The announcement's listener suspends a while before it notes the ticket, so a turn that does not wait for it notes its start first.
      const queued = onQueued((ticket) => Effect.andThen(Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { concurrency: 1, discard: true }), note(`queued ${ticket}`)))
      const started = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(turnStartedEvent, (event) => note(`started ${event.data.turn}`), { name: "turns", wait: true })))
      const kit = yield* inboxOver((call) => answer(`Reply ${call + 1}.`), { extras: inOrder(queued, started) })
      // Two messages at once, then each next one as the reply before it is given, after a few steps of the caller: the
      // worker, which runs on after giving a reply, is then looking for the next message, or has found none yet.
      let last = (yield* Effect.forEach([1, 2], (ticket) => kit.inbox.enqueue(kit.session, `Message ${ticket}`), { concurrency: 1 })).at(-1)
      for (const ticket of tickets.slice(2)) {
        if (last !== undefined) yield* last.reply
        yield* Effect.forEach(Array.from({ length: ticket % 4 }), () => Effect.yieldNow, { concurrency: 1, discard: true })
        last = yield* kit.inbox.enqueue(kit.session, `Message ${ticket}`)
      }
      if (last !== undefined) yield* last.reply
      const all = yield* Ref.get(lines)
      const at = (line: string) => all.indexOf(line)
      return {
        budget,
        before: tickets.every((ticket) => at(`queued ${ticket}`) >= 0 && at(`queued ${ticket}`) < at(`started ${ticket}`)),
        order: all.filter((line) => line.startsWith("queued")),
      }
    }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget))), { concurrency: 1 }))
    expect(results).toEqual(budgets.map((budget) => ({ budget, before: true, order: tickets.map((ticket) => `queued ${ticket}`) })))
  })

  test("announces a message after the session's message before it, though that one was taken and its announcement is still held", async () => {
    const result = await run(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const heard = yield* Ref.make<ReadonlyArray<number>>([])
      // The first announcement is held; the worker takes its message and waits for it, so the first message no longer waits.
      const kit = yield* inboxOver((call) => answer(`Reply ${call + 1}.`), {
        capacity: 1,
        extras: onQueued((ticket) => Effect.andThen(ticket === 1 ? Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)) : Effect.void, Ref.update(heard, (all) => [...all, ticket]))),
      })
      const first = yield* kit.inbox.enqueue(kit.session, "One")
      yield* Deferred.await(entered)
      // With a queue of one, the second message is taken in only once the first has left the queue.
      const second = yield* kit.inbox.enqueue(kit.session, "Two").pipe(Effect.retry({ while: (refused) => refused.reason === "Full" }))
      const before = yield* Ref.get(heard)
      yield* Deferred.succeed(go, undefined)
      const replies = [yield* first.reply, yield* second.reply]
      return { before, replies, heard: yield* Ref.get(heard) }
    }))
    expect(result).toEqual({ before: [], replies: [{ text: "Reply 1." }, { text: "Reply 2." }], heard: [1, 2] })
  })

  test("a waiting listener of plugin.inbox.queued that does not suspend has heard of the message when enqueue returns", async () => {
    const result = await run(Effect.gen(function* () {
      const heard = yield* Ref.make<ReadonlyArray<number>>([])
      const kit = yield* inboxOver((call) => answer(`Reply ${call + 1}.`), { extras: onQueued((ticket) => Ref.update(heard, (all) => [...all, ticket])) })
      const queued = yield* kit.inbox.enqueue(kit.session, "One")
      const now = yield* Ref.get(heard)
      yield* queued.reply
      return now
    }))
    expect(result).toEqual([1])
  })

  test("a slow turn.ended listener delays the next message, and does not fail it with SessionBusy", async () => {
    const result = await run(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const ends = yield* Ref.make(0)
      // A listener the end of a turn waits for, which holds the first end until it is let go.
      const slow = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(turnEndedEvent, () => Effect.flatMap(Ref.updateAndGet(ends, (count) => count + 1), (count) =>
        count === 1 ? Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)) : Effect.void), { name: "slow", wait: true })))
      const kit = yield* inboxOver((call) => answer(`Reply ${call + 1}.`), { sessions: { closeWait: "1 minute" }, extras: slow })
      const queued = yield* Effect.forEach(["One", "Two"], (message) => kit.inbox.enqueue(kit.session, message), { concurrency: 1 })
      yield* Deferred.await(entered)
      // The first end is stored and being announced: the second message has not started a turn.
      const during = yield* kit.names
      yield* Deferred.succeed(go, undefined)
      const replies = yield* Effect.forEach(queued, (entry) => entry.reply, { concurrency: "unbounded" })
      return { during, replies, names: yield* kit.names }
    }))
    expect(result.during).toEqual(FIVE)
    expect(result.during.filter((name) => name === turnStartedEvent.name)).toHaveLength(1)
    expect(result.replies).toEqual([{ text: "Reply 1." }, { text: "Reply 2." }])
    expect(result.names).toEqual([...FIVE, ...FIVE])
  })
})
