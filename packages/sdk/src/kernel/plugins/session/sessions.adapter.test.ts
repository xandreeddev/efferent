import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Scheduler, Schema } from "effect"
import type { Scope } from "effect"
import { Core, kernel, Owner, SessionId, Sessions, JournalStorage, JournalStorageError, stored, storedEvent, turnEndedEvent } from "@xandreed/core/kernel"
import type { StoredDraft } from "@xandreed/core/kernel"
import { inProcessJournal } from "../journal-in-process/journal.adapter.js"
import { sessions } from "./sessions.adapter.js"

const owner = Owner.make("learner")
const STARTED = "plugin.session.turn.started"
const ENDED = "plugin.session.turn.ended"
const noted = storedEvent("notes", "noted", { data: Schema.Struct({}), skippable: true })

/** What a storage double does with one append: let it through, refuse it, or die. */
type Fault = (event: StoredDraft) => Option.Option<Effect.Effect<never, JournalStorageError>>
const through: Fault = () => Option.none()
/** Fail the appends of `name` with a storage error of `reason`. */
const failing = (name: string, reason: JournalStorageError["reason"]): Fault => (event) =>
  event.name === name ? Option.some(Effect.fail(new JournalStorageError({ reason, message: `the store was told to refuse ${name}` }))) : Option.none()
const dying = (name: string): Fault => (event) => event.name === name ? Option.some(Effect.die("the store broke")) : Option.none()

/** What a storage double does before an append goes through: nothing, or suspend for a while. */
type Pause = (event: StoredDraft) => Effect.Effect<void>
const atOnce: Pause = () => Effect.void

/**
 * The stock storage behind a double whose appends can be told to fail or
 * to suspend before they go through, and as many session plugins over that
 * one store as asked for.
 */
const over = (count: number) => Effect.gen(function* () {
  const below = yield* Layer.build(Layer.provideMerge(inProcessJournal(), kernel({ system: "You are a kit." })))
  const real = Context.get(below, JournalStorage)
  const fault = yield* Ref.make<Fault>(through)
  const pause = yield* Ref.make<Pause>(atOnce)
  const storage = JournalStorage.of({
    ...real,
    append: (id, expectedSeq, event) => Effect.flatMap(Ref.get(fault), (decide) => Option.getOrElse(decide(event), () =>
      Effect.andThen(Effect.flatMap(Ref.get(pause), (wait) => wait(event)), real.append(id, expectedSeq, event)))),
  })
  const parts = Layer.merge(Layer.succeed(Core, Context.get(below, Core)), Layer.succeed(JournalStorage, storage))
  const plugins = yield* Effect.forEach(Array.from({ length: count }), () =>
    Effect.map(Layer.build(Layer.provide(sessions(), parts)), (built) => Context.get(built, Sessions)), { concurrency: 1 })
  const names = (id: Parameters<typeof real.read>[0]) => Effect.map(real.read(id), (journal) => journal.events.map((event): string => event.name))
  return { plugins, core: Context.get(below, Core), fault: (next: Fault) => Ref.set(fault, next), pause: (next: Pause) => Ref.set(pause, next), names }
})

/** Every test gives itself five seconds: code that waits on what never comes fails here and does not hang the run. */
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.timeout("5 seconds")))

describe("the writes of one open turn", () => {
  test("are stored one after another: two appends made at once both succeed, in the order they were made", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], pause, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      // Every append suspends before it goes through, so the second is made while the first is under way.
      yield* pause(() => Effect.sleep("1 millis"))
      const seqs = yield* turns.turn(id, (session) => Effect.all([session.append(stored(noted, {})), session.append(stored(noted, {}))], { concurrency: "unbounded" }).pipe(
        Effect.map((all) => all.map((event): number => event.seq))))
      const next = yield* turns.turn(id, (session) => Effect.succeed(Number(session.turn)))
      return { seqs, next, names: yield* names(id) }
    }))
    expect(result.seqs).toEqual([2, 3])
    expect(result.names).toEqual([STARTED, noted.name, noted.name, ENDED, STARTED, ENDED])
    expect(result.next).toBe(2)
  })

  test("an append the body forked and left under way is stored before the turn's end, and the next turn opens", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], pause, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      const entered = yield* Deferred.make<void>()
      // The noted append says it is under way, then suspends; so does the end's.
      yield* pause((event) => Effect.andThen(event.name === noted.name ? Deferred.succeed(entered, undefined) : Effect.void, Effect.sleep("1 millis")))
      // The body forks the append and returns as soon as it is under way, without waiting for it.
      yield* turns.turn(id, (session) => Effect.andThen(Effect.forkDetach(session.append(stored(noted, {}))), Deferred.await(entered)))
      yield* pause(atOnce)
      const next = yield* turns.turn(id, (session) => Effect.succeed(Number(session.turn)))
      return { next, names: yield* names(id) }
    }))
    expect(result.names).toEqual([STARTED, noted.name, ENDED, STARTED, ENDED])
    expect(result.next).toBe(2)
  })
})

describe("the end of a turn", () => {
  /*
   * A background listener hears of the end on its own fiber, once the end was
   * handed over. Under the default scheduler the publisher frees the session
   * before that fiber runs, whatever the order of its steps; a scheduler that
   * makes every fiber yield after a few operations lets the listener run at
   * any point after the hand-over, so the session must be free by then.
   */
  const budgets = Array.from({ length: 61 }, (_, index) => index + 4)

  test("finds the session free for a background listener of plugin.session.turn.ended that opens the next turn in its handler, wherever the publisher is preempted", async () => {
    const results = await run(Effect.forEach(budgets, (budget) => Effect.scoped(Effect.gen(function* () {
      const { plugins: [turns], core } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      const next = yield* Deferred.make<number, unknown>()
      // A background listener: it hears of the end after the end was handed over, and opens the next turn at once.
      yield* core.on(turnEndedEvent, (ended) => ended.data.turn === 1
        ? Effect.exit(turns.turn(id, (session) => Effect.succeed(Number(session.turn)))).pipe(Effect.flatMap((exit) => Deferred.done(next, exit)))
        : Effect.void, { name: "follower" })
      yield* turns.turn(id, () => Effect.void)
      return yield* Effect.match(Deferred.await(next), { onSuccess: (turn) => ({ budget, turn }), onFailure: (failure) => ({ budget, failure }) })
    }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget))), { concurrency: 1 }))
    expect(results).toEqual(budgets.map((budget) => ({ budget, turn: 2 })))
  })
})

describe("a turn whose end cannot be stored", () => {
  test("stays open, as the journal says it is: the caller gets the failure, no second start is written, and the session still reads", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], fault, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      yield* fault(failing(ENDED, "Unavailable"))
      const failed = yield* Effect.flip(turns.turn(id, () => Effect.succeed("done")))
      yield* fault(through)
      const next = yield* Effect.flip(turns.turn(id, () => Effect.succeed("again")))
      return { failed, next, names: yield* names(id), read: (yield* turns.read(id)).events.length }
    }))
    expect(result.failed).toMatchObject({ _tag: "JournalStorageError", reason: "Unavailable" })
    // The journal holds a turn that started and never ended: the session is busy, and nothing was written over it.
    expect(result.next).toMatchObject({ _tag: "SessionRefused", reason: "SessionBusy" })
    expect(result.names).toEqual([STARTED])
    expect(result.read).toBe(1)
  })
})

describe("a turn that cannot open", () => {
  test("because another writer took the place of its start is refused as busy, not as a storage failure, and holds nothing", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], fault, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      yield* fault(failing(STARTED, "SeqConflict"))
      const refused = yield* Effect.flip(turns.turn(id, () => Effect.void))
      yield* fault(through)
      return { refused, turn: yield* turns.turn(id, (session) => Effect.succeed(Number(session.turn))), names: yield* names(id) }
    }))
    expect(result.refused).toMatchObject({ _tag: "SessionRefused", reason: "SessionBusy" })
    expect(result.turn).toBe(1)
    expect(result.names).toEqual([STARTED, ENDED])
  })

  test("because the store broke under it, with a failure or a defect, leaves the session free for the next turn", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], fault, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      yield* fault(failing(STARTED, "Unavailable"))
      const failed = yield* Effect.flip(turns.turn(id, () => Effect.void))
      yield* fault(dying(STARTED))
      const died = yield* Effect.exit(turns.turn(id, () => Effect.void))
      yield* fault(through)
      return { failed, died: died._tag, turn: yield* turns.turn(id, (session) => Effect.succeed(Number(session.turn))), names: yield* names(id) }
    }))
    expect(result.failed).toMatchObject({ _tag: "JournalStorageError", reason: "Unavailable" })
    expect(result.died).toBe("Failure")
    // Neither left the session held: the next turn is the first the journal holds.
    expect(result.turn).toBe(1)
    expect(result.names).toEqual([STARTED, ENDED])
  })
})

describe("two session plugins over one store", () => {
  test("take turns on one session: each begins from what the journal holds, however often the other ran", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [first, second] } = yield* over(2)
      if (first === undefined || second === undefined) return yield* Effect.die("no session plugins")
      const id = yield* first.create({ owner })
      const turn = (turns: typeof first) => turns.turn(id, (session) => Effect.as(session.append(stored(noted, {})), Number(session.turn)))
      const numbers = [yield* turn(first), yield* turn(second), yield* turn(first), yield* turn(first), yield* turn(second)]
      return { numbers, seqs: (yield* second.read(id)).events.map((event): number => event.seq) }
    }))
    expect(result.numbers).toEqual([1, 2, 3, 4, 5])
    expect(result.seqs).toEqual(Array.from({ length: 15 }, (_, index) => index + 1))
  })

  test("one refuses a turn while the other's is open, and takes the next when it has closed", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [first, second] } = yield* over(2)
      if (first === undefined || second === undefined) return yield* Effect.die("no session plugins")
      const id = yield* first.create({ owner })
      const open = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const running = yield* Effect.forkScoped(first.turn(id, () => Effect.andThen(Deferred.succeed(open, undefined), Deferred.await(go))))
      yield* Deferred.await(open)
      const refused = yield* Effect.flip(second.turn(id, () => Effect.void))
      yield* Deferred.succeed(go, undefined)
      yield* Fiber.join(running)
      return { refused, next: yield* second.turn(id, (session) => Effect.succeed(Number(session.turn))) }
    }))
    expect(result.refused).toMatchObject({ _tag: "SessionRefused", reason: "SessionBusy" })
    expect(result.next).toBe(2)
  })
})

describe("a session's id", () => {
  test("is a version 4 UUID from the platform's random source, a new one each time", async () => {
    const ids = await run(Effect.gen(function* () {
      const { plugins: [turns] } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      return (yield* Effect.forEach(Array.from({ length: 8 }), () => turns.create({ owner }), { concurrency: 1 })).map(String)
    }))
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(new Set(ids).size).toBe(8)
  })

  test("is the one the plugin was told to mint, when it was told how", async () => {
    const result = await run(Effect.gen(function* () {
      const minted = yield* Ref.make(0)
      const mintId = Effect.map(Ref.updateAndGet(minted, (count) => count + 1), (count) => SessionId.make(`session-${count}`))
      const below = yield* Layer.build(Layer.provideMerge(sessions({ mintId }), Layer.provideMerge(inProcessJournal(), kernel({ system: "You are a kit." }))))
      const turns = Context.get(below, Sessions)
      const ids = [yield* turns.create({ owner }), yield* turns.create({ owner })]
      return { ids: ids.map(String), turn: yield* turns.turn(SessionId.make("session-2"), (session) => Effect.succeed(Number(session.turn))) }
    }))
    expect(result.ids).toEqual(["session-1", "session-2"])
    expect(result.turn).toBe(1)
  })
})
