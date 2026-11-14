import { describe, expect, test } from "bun:test"
import { Array as Arr, Clock, Context, Deferred, Effect, Fiber, Layer, Option, Order, Ref, Scheduler, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { Core, JOURNAL_FORMAT, kernel, listenerFailedEvent, liveEvent, Owner, Seq, SessionId, Sessions, JournalStorage, JournalStorageError, stored, storedEvent, turnEnded, turnEndedEvent, turnStarted, turnStartedEvent, TurnNumber } from "@xandreed/core/kernel"
import type { StoredDraft } from "@xandreed/core/kernel"
import { inProcessJournal } from "../journal-in-process/journal.adapter.js"
import { sessions } from "./sessions.adapter.js"
import type { SessionsOptions } from "./sessions.adapter.js"

const owner = Owner.make("learner")
const STARTED = "core.session.turn.started"
const ENDED = "core.session.turn.ended"
const noted = storedEvent("notes", "noted", { tags: ["trace"], data: Schema.Struct({}), skippable: true })

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
 * What a storage double does once an append went through, as a remote store
 * may: nothing, or keep the caller waiting, or report a failure, the event
 * stored all the same.
 */
type After = (event: StoredDraft) => Effect.Effect<void, JournalStorageError>
const acknowledged: After = () => Effect.void

/**
 * The stock storage behind a double whose appends can be told to fail or
 * to suspend before they go through, and as many session plugins over that
 * one store as asked for.
 */
const over = (count: number, options: SessionsOptions = {}) => Effect.gen(function* () {
  const below = yield* Layer.build(Layer.provideMerge(inProcessJournal(), kernel()))
  const real = Context.get(below, JournalStorage)
  const fault = yield* Ref.make<Fault>(through)
  const pause = yield* Ref.make<Pause>(atOnce)
  const after = yield* Ref.make<After>(acknowledged)
  const storage = JournalStorage.of({
    ...real,
    append: (id, expectedSeq, turn, event) => Effect.flatMap(Ref.get(fault), (decide) => Option.getOrElse(decide(event), () =>
      Effect.andThen(Effect.flatMap(Ref.get(pause), (wait) => wait(event)), real.append(id, expectedSeq, turn, event)).pipe(
        Effect.tap(() => Effect.flatMap(Ref.get(after), (then) => then(event)))))),
  })
  const parts = Layer.merge(Layer.succeed(Core, Context.get(below, Core)), Layer.succeed(JournalStorage, storage))
  const plugins = yield* Effect.forEach(Array.from({ length: count }), () =>
    Effect.map(Layer.build(Layer.provide(sessions(options), parts)), (built) => Context.get(built, Sessions)), { concurrency: 1 })
  const names = (id: Parameters<typeof real.read>[0]) => Effect.map(real.read(id), (journal) => journal.events.map((event): string => event.name))
  return { plugins, core: Context.get(below, Core), storage: real, fault: (next: Fault) => Ref.set(fault, next), pause: (next: Pause) => Ref.set(pause, next), after: (next: After) => Ref.set(after, next), names }
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

  test("finds the session free for a background listener of core.session.turn.ended that opens the next turn in its handler, wherever the publisher is preempted", async () => {
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

  test("stored by recover finds the session free for such a listener too, wherever the publisher is preempted", async () => {
    const results = await run(Effect.forEach(budgets, (budget) => Effect.scoped(Effect.gen(function* () {
      const { plugins: [turns], core, storage } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      // A writer that is gone left turn 1 open.
      yield* storage.append(id, Seq.make(0), TurnNumber.make(1), turnStarted(TurnNumber.make(1)))
      const next = yield* Deferred.make<number, unknown>()
      yield* core.on(turnEndedEvent, (ended) => ended.data.turn === 1
        ? Effect.exit(turns.turn(id, (session) => Effect.succeed(Number(session.turn)))).pipe(Effect.flatMap((exit) => Deferred.done(next, exit)))
        : Effect.void, { name: "follower" })
      yield* turns.recover(id)
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

describe("an append whose store did not report success", () => {
  /** The next end of a turn as the stream hands it over, read from now: the session is free once it is there. */
  const endOnStream = (core: Context.Service.Shape<typeof Core>) =>
    Effect.forkScoped(Stream.runHead(Stream.filter(core.events, (event) => event.name === ENDED)), { startImmediately: true })

  test("interrupted while its store, which has committed, still keeps it waiting: the turn's end is stored after it, and the next turn opens", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], core, after, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      const committed = yield* Deferred.make<void>()
      // The noted record is stored, and then the store keeps its caller waiting, as a remote store may before it answers.
      yield* after((event) => event.name === noted.name ? Effect.andThen(Deferred.succeed(committed, undefined), Effect.never) : Effect.void)
      const handed = yield* endOnStream(core)
      const running = yield* Effect.forkChild(turns.turn(id, (session) => session.append(stored(noted, {}))))
      yield* Deferred.await(committed)
      yield* Fiber.interrupt(running)
      const stored_ = yield* names(id)
      yield* after(acknowledged)
      const announced = yield* Effect.timeoutOption(Fiber.join(handed), "1 second")
      const next = yield* Effect.exit(turns.turn(id, (session) => Effect.succeed(Number(session.turn))))
      return { stored: stored_, announced: Option.isSome(announced), next, names: yield* names(id) }
    }))
    expect(result.stored).toEqual([STARTED, noted.name, ENDED])
    expect(result.announced).toBe(true)
    expect(result.next).toMatchObject({ _tag: "Success", value: 2 })
    expect(result.names).toEqual([STARTED, noted.name, ENDED, STARTED, ENDED])
  })

  test("refused by a store that committed it and then reported a failure: the turn's end is stored after it, and the next turn opens", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], after, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      // The noted record is stored, and then the store says it could not store it: an uncertain acknowledgement.
      yield* after((event) => event.name === noted.name ? Effect.fail(new JournalStorageError({ reason: "Unavailable", message: "the answer was lost" })) : Effect.void)
      const refused = yield* turns.turn(id, (session) => Effect.flip(session.append(stored(noted, {}))))
      yield* after(acknowledged)
      const next = yield* Effect.exit(turns.turn(id, (session) => Effect.succeed(Number(session.turn))))
      return { refused, next, names: yield* names(id) }
    }))
    expect(result.refused).toMatchObject({ _tag: "JournalStorageError", reason: "Unavailable" })
    expect(result.next).toMatchObject({ _tag: "Success", value: 2 })
    expect(result.names).toEqual([STARTED, noted.name, ENDED, STARTED, ENDED])
  })
})

describe("an append of a record named under core.", () => {
  test("is refused with ReservedName, whatever the record, and nothing is stored or announced", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], core, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      yield* Effect.forEach([turnStartedEvent, turnEndedEvent], (definition) => core.on(definition, (event) => Ref.update(heard, (all) => [...all, event.name]), { name: "watch", wait: true }), { concurrency: 1, discard: true })
      const drafts = [
        turnEnded(TurnNumber.make(1), { _tag: "Completed" }),
        turnStarted(TurnNumber.make(2)),
      ]
      const refusals = yield* turns.turn(id, (session) => Effect.forEach(drafts, (draft) => Effect.flip(session.append(draft)), { concurrency: 1 }))
      const next = yield* turns.turn(id, (session) => Effect.succeed(Number(session.turn)))
      return { refusals: refusals.map((refusal) => refusal._tag === "SessionRefused" ? refusal.reason : refusal._tag), next, names: yield* names(id), heard: yield* Ref.get(heard) }
    }))
    expect(result.refusals).toEqual(["ReservedName", "ReservedName"])
    expect(result.names).toEqual([STARTED, ENDED, STARTED, ENDED])
    expect(result.heard).toEqual([STARTED, ENDED, STARTED, ENDED])
    expect(result.next).toBe(2)
  })
})

describe("a turn interrupted while it opens", () => {
  test("has its start announced before its end, though its body never ran", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], core, pause, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      const ended = yield* Deferred.make<void>()
      yield* core.on(turnStartedEvent, (event) => Ref.update(heard, (all) => [...all, event.name]), { name: "watch", wait: true })
      yield* core.on(turnEndedEvent, (event) => Effect.andThen(Ref.update(heard, (all) => [...all, event.name]), Deferred.succeed(ended, undefined)), { name: "watch", wait: true })
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      // The start's store holds the turn in its opening, which no interrupt cuts: the interrupt is delivered as the body would begin.
      yield* pause((event) => event.name === STARTED ? Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)) : Effect.void)
      const ran = yield* Ref.make(false)
      const running = yield* Effect.forkChild(turns.turn(id, () => Ref.set(ran, true)))
      yield* Deferred.await(entered)
      const stopping = yield* Effect.forkChild(Fiber.interrupt(running), { startImmediately: true })
      yield* Deferred.succeed(go, undefined)
      yield* Fiber.join(stopping)
      yield* Effect.timeoutOption(Deferred.await(ended), "1 second")
      return { ran: yield* Ref.get(ran), heard: yield* Ref.get(heard), names: yield* names(id) }
    }))
    expect(result.ran).toBe(false)
    expect(result.names).toEqual([STARTED, ENDED])
    expect(result.heard).toEqual([STARTED, ENDED])
  })
})

describe("a turn interrupted while it opens, whose start a waiting listener never lets go", () => {
  test("still has its end handed to the stream: the start's wait is cut after closeWait, and the end's publish runs", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], core, pause, names } = yield* over(1, { closeWait: "50 millis" })
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      // The listener holds the start for as long as it is let: only the late announcement reaches it, the body never running.
      yield* core.on(turnStartedEvent, () => Effect.never, { name: "stuck", wait: true })
      const handed = yield* Effect.forkScoped(Stream.runHead(Stream.filter(core.events, (event) => event.name === ENDED)), { startImmediately: true })
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      yield* pause((event) => event.name === STARTED ? Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)) : Effect.void)
      const running = yield* Effect.forkChild(turns.turn(id, () => Effect.void))
      yield* Deferred.await(entered)
      const stopping = yield* Effect.forkChild(Fiber.interrupt(running), { startImmediately: true })
      yield* Deferred.succeed(go, undefined)
      yield* Fiber.join(stopping)
      const ended = yield* Effect.timeoutOption(Fiber.join(handed), "1 second")
      return { names: yield* names(id), ended: Option.isSome(Option.flatten(ended)) }
    }))
    expect(result).toEqual({ names: [STARTED, ENDED], ended: true })
  })
})

describe("the listeners the end of a turn waits for", () => {
  test("all hear it: one that fails holds back none after it, and is reported", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], core } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      const heard = yield* Deferred.make<number>()
      const reported = yield* Deferred.make<unknown>()
      yield* core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event.data), { name: "reports" })
      yield* core.on(turnEndedEvent, () => Effect.fail(new JournalStorageError({ reason: "Unavailable", message: "the first listener failed" })), { name: "first", wait: true })
      yield* core.on(turnEndedEvent, (event) => Deferred.succeed(heard, Number(event.data.turn)), { name: "second", wait: true })
      const value = yield* turns.turn(id, () => Effect.succeed("done"))
      return {
        value,
        heard: yield* Effect.timeoutOption(Deferred.await(heard), "1 second"),
        reported: yield* Effect.timeoutOption(Deferred.await(reported), "1 second"),
      }
    }))
    expect(result.value).toBe("done")
    expect(result.heard).toEqual(Option.some(1))
    expect(result.reported).toEqual(Option.some({ listener: "first", event: ENDED, reason: "JournalStorageError: the first listener failed" }))
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

describe("a turn whose writer is taken for gone", () => {
  /** The outcomes of the turns a journal holds, in order. */
  const outcomes = (events: ReadonlyArray<{ readonly name: string; readonly data: unknown }>) =>
    events.flatMap((event) => event.name === ENDED ? [(event.data as { readonly outcome: { readonly _tag: string } }).outcome._tag] : [])

  test("is closed by another plugin's recover: the writer's next append is refused, its close stores no second end, and the next turn opens", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [writer, host], names, storage } = yield* over(2)
      if (writer === undefined || host === undefined) return yield* Effect.die("no session plugins")
      const id = yield* writer.create({ owner })
      const recovered = yield* writer.turn(id, (session) => Effect.gen(function* () {
        yield* session.append(stored(noted, {}))
        const closed = yield* host.recover(id)
        const late = yield* Effect.flip(session.append(stored(noted, {})))
        return { closed, late }
      }))
      const after = yield* names(id)
      return { ...recovered, after, outcomes: outcomes((yield* storage.read(id)).events), next: yield* host.turn(id, (session) => Effect.succeed(Number(session.turn))) }
    }))
    expect(result.closed).toEqual(Option.some(TurnNumber.make(1)))
    expect(result.late).toMatchObject({ _tag: "SessionRefused", reason: "NoOpenTurn" })
    expect(result.late.message).toMatch(/^turn 1 of session .+ is no longer open in the journal: another writer closed it$/)
    expect(result.after).toEqual([STARTED, "plugin.notes.noted", ENDED])
    expect(result.outcomes).toEqual(["Abandoned"])
    expect(result.next).toBe(2)
  })

  test("and writes nothing more before it closes: its close finds the other's end in the journal, and stores none of its own", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [writer, host], names, storage } = yield* over(2)
      if (writer === undefined || host === undefined) return yield* Effect.die("no session plugins")
      const id = yield* writer.create({ owner })
      const value = yield* writer.turn(id, () => Effect.as(host.recover(id), "the body's value"))
      return { value, after: yield* names(id), outcomes: outcomes((yield* storage.read(id)).events), next: yield* writer.turn(id, (session) => Effect.succeed(Number(session.turn))) }
    }))
    expect(result).toEqual({ value: "the body's value", after: [STARTED, ENDED], outcomes: ["Abandoned"], next: 2 })
  })

  test("is not recovered by the plugin that holds it, nor a free session by anyone: nothing is stored", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      const held = yield* turns.turn(id, () => Effect.flip(turns.recover(id)))
      const free = yield* turns.recover(id)
      return { held: [held._tag, held.message], free, after: yield* names(id) }
    }))
    expect(result.held[0]).toBe("SessionRefused")
    expect(result.held[1]).toMatch(/^session .+ is busy: a turn is open, or its end is being announced$/)
    expect(result.free).toEqual(Option.none())
    expect(result.after).toEqual([STARTED, ENDED])
  })
})

describe("a session's header", () => {
  test("is stamped with the time it was created at, and the sessions are listed by it", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns] } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const before = yield* Clock.currentTimeMillis
      const first = yield* turns.create({ owner })
      const second = yield* turns.create({ owner, parent: first })
      const listed = yield* turns.list
      return { fresh: listed.every((header) => header.createdAt >= before && header.format === JOURNAL_FORMAT), ids: Arr.sort(listed.map((header): string => header.id), Order.String), expected: Arr.sort([first, second].map(String), Order.String), parents: listed.filter((header) => header.parent === first).length }
    }))
    expect(result.fresh).toBe(true)
    expect(result.ids).toEqual(result.expected)
    expect(result.parents).toBe(1)
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
      const below = yield* Layer.build(Layer.provideMerge(sessions({ mintId }), Layer.provideMerge(inProcessJournal(), kernel())))
      const turns = Context.get(below, Sessions)
      const ids = [yield* turns.create({ owner }), yield* turns.create({ owner })]
      return { ids: ids.map(String), turn: yield* turns.turn(SessionId.make("session-2"), (session) => Effect.succeed(Number(session.turn))) }
    }))
    expect(result.ids).toEqual(["session-1", "session-2"])
    expect(result.turn).toBe(1)
  })
})

describe("what a session refuses to store or to open", () => {
  test("a value `stored` did not make from a definition `storedEvent` made is refused with NotADraft, and the turn goes on", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      const refusals = yield* turns.turn(id, (session) => Effect.gen(function* () {
        const copy = yield* Effect.flip(session.append({ ...stored(noted, {}) }))
        const changed = yield* Effect.flip(session.append({ ...stored(noted, {}), skippable: false }))
        // A definition written by hand could declare a tag no part reads by: what `stored` makes of it is no record.
        const byHand = yield* Effect.flip(session.append(stored({ kind: "stored", name: noted.name, data: Schema.Struct({}), skippable: true, tags: noted.tags }, {})))
        yield* session.append(stored(noted, {}))
        return [copy, changed, byHand].map((refusal) => refusal._tag === "SessionRefused" ? `${refusal.reason}: ${refusal.message}` : refusal._tag)
      }))
      return { refusals, names: yield* names(id) }
    }))
    const message = "NotADraft: this value is not a record `stored(definition, data)` made from a definition `storedEvent` made: build a record with `stored`, or with `userMessage`, `assistantMessage` or `toolResult`, never by hand or as a copy"
    expect(result.refusals).toEqual([message, message, message])
    expect(result.names).toEqual([STARTED, "plugin.notes.noted", ENDED])
  })

  test("a journal written in another format is read as it is, and no turn opens on it: nothing is stored", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], storage, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = SessionId.make("from-a-later-kernel")
      yield* storage.create({ id, owner, createdAt: 1, format: JOURNAL_FORMAT + 1 })
      const ran = yield* Ref.make(false)
      const told = (refusal: { readonly _tag: string; readonly reason?: string }) => refusal.reason ?? refusal._tag
      const turned = yield* Effect.flip(turns.turn(id, () => Ref.set(ran, true)))
      const opened = yield* Effect.flip(Effect.scoped(turns.open(id)))
      const read = yield* turns.read(id)
      return { turned: told(turned), opened: told(opened), ran: yield* Ref.get(ran), format: read.header.format, names: yield* names(id) }
    }))
    expect(result).toEqual({ turned: "FormatMismatch", opened: "FormatMismatch", ran: false, format: JOURNAL_FORMAT + 1, names: [] })
  })
})

describe("a live event published through the open session", () => {
  const glanced = liveEvent("notes", "glanced", { tags: ["trace"], data: Schema.Struct({ at: Schema.String }) })

  test("is about its session and turn, reaches Core's listeners and stream, and is stored nowhere", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], core, names } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      yield* core.on(glanced, (event) => Ref.update(heard, (all) => [...all, `${event.session === id ? "this session" : "another"} turn ${event.turn ?? "none"} at ${event.data.at}`]), { name: "watch", wait: true })
      yield* turns.turn(id, (session) => session.publish(glanced, { at: "the first step" }))
      yield* turns.turn(id, (session) => session.publish(glanced, { at: "the second turn" }))
      return { heard: yield* Ref.get(heard), names: yield* names(id) }
    }))
    expect(result.heard).toEqual(["this session turn 1 at the first step", "this session turn 2 at the second turn"])
    expect(result.names).toEqual([STARTED, ENDED, STARTED, ENDED])
  })

  test("is refused with NoOpenTurn once its turn closed, and a waiting listener that fails fails the publish", async () => {
    const result = await run(Effect.gen(function* () {
      const { plugins: [turns], core } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      const id = yield* turns.create({ owner })
      const kept = yield* turns.turn(id, (session) => Effect.succeed(session))
      const late = yield* Effect.flip(kept.publish(glanced, { at: "too late" }))
      yield* core.on(glanced, () => Effect.fail(new JournalStorageError({ reason: "Unavailable", message: "the watcher broke" })), { name: "watch", wait: true })
      const failed = yield* turns.turn(id, (session) => Effect.flip(session.publish(glanced, { at: "watched" })))
      return [late, failed].map((failure) => failure._tag === "SessionRefused" ? failure.reason : `${failure._tag} of ${failure.listener}`)
    }))
    expect(result).toEqual(["NoOpenTurn", "ListenerFailed of watch"])
  })
})
