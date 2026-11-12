import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Scope, Stream } from "effect"
import type { AiError, Response } from "effect/ai"
import { Core, inspectionOf, Sessions, turnEndedEvent, turnStartedEvent } from "@xandreed/core/kernel"
import type { Settings } from "@xandreed/core/kernel"
import type { SessionsOptions } from "../../index.js"
import { answer, modelDown, scripted, stack } from "../../testing.js"
import { inboxOf } from "./inbox.adapter.js"
import { Inbox } from "./inbox.port.js"

const FIVE = ["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.loop.assistant.message", "plugin.session.turn.ended"]

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
      const kit = yield* inboxOver((call) => call === 1 ? Stream.fail(modelDown) : answer(`Reply ${call + 1}.`))
      const queued = yield* Effect.forEach(["One", "Two", "Three"], (message) => kit.inbox.enqueue(kit.session, message), { concurrency: 1 })
      const replies = yield* Effect.forEach(queued, (entry) => Effect.result(entry.reply), { concurrency: "unbounded" })
      return { tickets: queued.map((entry) => Number(entry.ticket)), replies, ends: yield* kit.ends, received: yield* kit.received }
    }))
    expect(result.tickets).toEqual([1, 2, 3])
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
