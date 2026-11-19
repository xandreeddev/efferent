import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { Core, EventName, JournalStorage, kernel, messageOf, Owner, Seq, Sessions, stored, storedEvent, TurnNumber, userMessageEvent } from "@xandreed/core"
import type { SessionId, StoredDraft } from "@xandreed/core"
import { Memory } from "./contracts/memory/memory.port.js"
import { flatMemory, inProcessJournal, promptMessage, sessions, Summarizer, summaryMemory } from "./index.js"
import type { InvalidBudget } from "./index.js"
import { answering, base, open, SYSTEM } from "./testing.js"

/*
 * Records a later release of a plugin might write, which this one does not
 * know: one under the flat memory's prefix, one under core's, where the
 * session's records are. Each says whether a reader that does not know it
 * may skip it.
 */
const flatFuture = (skippable: boolean) => stored(storedEvent("flat", "future", { tags: ["memory"], data: Schema.Struct({ note: Schema.String }), skippable }), { note: "from a later release" })
const sessionFuture = (skippable: boolean) =>
  stored({ ...storedEvent("any", "future", { tags: ["trace"], data: Schema.Struct({}), skippable }), name: EventName.make("core.session.future") }, {})
/**
 * Store a record after the last one a session's journal holds, between its turns, as a later release of the session
 * plugin, the one writer of core's records, would: no turn's body may append a record named under `core.`.
 */
const storedByAnotherRelease = (storage: Context.Service.Shape<typeof JournalStorage>, id: SessionId, draft: StoredDraft) =>
  Effect.flatMap(storage.read(id), (journal) => storage.append(id, Seq.make(journal.events.at(-1)?.seq ?? 0), TurnNumber.make(journal.events.at(-1)?.turn ?? 1), draft))
/** Another plugin's record, which may not be skipped by those it concerns. */
const stranger = stored(storedEvent("elsewhere", "noted", { tags: ["trace"], data: Schema.Struct({}), skippable: false }), {})

/** A memory that sends nothing but the turn's message and, before that, writes `records` into the journal. */
const scribe = (records: ReadonlyArray<ReturnType<typeof flatFuture>>): Layer.Layer<Memory> => Layer.succeed(Memory, Memory.of({
  context: (session) => Effect.gen(function* () {
    yield* Effect.forEach(records, (record) => session.append(record), { concurrency: 1, discard: true })
    const journal = yield* session.journal
    return journal.filter((event) => event.name === userMessageEvent.name).slice(-1).flatMap((event) => Option.toArray(messageOf(event))).map(promptMessage)
  }),
}))

/**
 * One turn under a memory that leaves `records` in the journal, then the stock flat memory over that journal: the
 * same base, a stack above it each. Records under `core.` are stored after that turn, as another release of the
 * session plugin would store them.
 */
const flatAfter = (records: ReadonlyArray<ReturnType<typeof flatFuture>>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model } = yield* answering("Fine.")
  const built = yield* Layer.build(base(model))
  const shared = Layer.succeedContext(built)
  const before = yield* Scope.make()
  const ours = (record: StoredDraft) => record.name.startsWith("core.")
  const first = yield* open(scribe(records.filter((record) => !ours(record))).pipe(Layer.provideMerge(shared))).pipe(Scope.provide(before))
  const session = yield* first.createSession({ owner: "learner" })
  yield* first.send(session, "One")
  yield* Effect.forEach(records.filter(ours), (record) => storedByAnotherRelease(Context.get(built, JournalStorage), session, record), { concurrency: 1, discard: true })
  yield* Scope.close(before, Exit.void)
  const agent = yield* open(flatMemory.pipe(Layer.provideMerge(shared)))
  const sent = yield* Effect.result(agent.send(session, "Two"))
  const inspected = yield* Effect.result(agent.inspect(session))
  return { sent, inspected }
})))

describe("a stored plugin record a reader does not know", () => {
  test("is skipped by the flat memory when the record says it may be", async () => {
    const result = await flatAfter([flatFuture(true)])
    expect(result.sent).toMatchObject({ _tag: "Success", success: "Fine." })
    expect(result.inspected).toMatchObject({ _tag: "Success", success: { state: { _tag: "Free", turns: 2 } } })
  })

  test("is refused by the flat memory with a typed error when it may not be, and the turn still closes", async () => {
    const result = await flatAfter([flatFuture(false)])
    expect(result.sent).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownRecord", name: "plugin.flat.future", seq: 3 } })
    const inspection = result.inspected._tag === "Success" ? result.inspected.success : undefined
    expect(inspection?.events.map((event): string => event.name).slice(5)).toEqual(["core.session.turn.started", "conversation.user.message", "core.session.turn.ended"])
    expect(inspection?.events.at(-1)?.data).toMatchObject({ outcome: { _tag: "Failed" } })
  })

  test("is no concern of a reader whose prefixes it is not under, whatever it says", async () => {
    const result = await flatAfter([stranger])
    expect(result.sent).toMatchObject({ _tag: "Success", success: "Fine." })
    expect(result.inspected).toMatchObject({ _tag: "Success" })
  })

  test("under core's prefix: skipped by the readers of the session's state when it may be, refused when it may not", async () => {
    const skipped = await flatAfter([sessionFuture(true)])
    expect(skipped.sent).toMatchObject({ _tag: "Success", success: "Fine." })
    expect(skipped.inspected).toMatchObject({ _tag: "Success", success: { state: { _tag: "Free", turns: 2 } } })
    const refused = await flatAfter([sessionFuture(false)])
    // The flat memory answers for `core.` too, and so does whoever folds the journal to a state.
    expect(refused.sent).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownRecord", name: "core.session.future" } })
    expect(refused.inspected).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownRecord", name: "core.session.future" } })
  })
})

/*
 * A journal a 0.23.0 host stored under the window memory, which later releases do not ship: the window wrote
 * `plugin.window.dropped` (tagged `memory`, skippable, `through` the place of the last message it left out) as it
 * dropped whole turns. The record is written here as that release defined it. The stock memories read the journal
 * through their own prefixes and the conversation's, so the window's record is another plugin's to them: passed over,
 * and the turns it had dropped are sent again.
 */
describe("a journal the window memory of 0.23.0 wrote", () => {
  const windowDropped = (through: number, skippable = true) =>
    stored(storedEvent("window", "dropped", { tags: ["memory"], data: Schema.Struct({ through: Seq }), skippable }), { through: Seq.make(through) })

  /** One turn under a memory that drops its message, as the window did, then a turn under `memory` over that journal. */
  const after = (memory: Layer.Layer<Memory, InvalidBudget>, skippable = true) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { model, received } = yield* answering("Fine.")
    const built = yield* Layer.build(base(model))
    const shared = Layer.succeedContext(built)
    const before = yield* Scope.make()
    // Turn 1 stores its start at 1 and "One" at 2; the record says every message at or before 2 left the window.
    const first = yield* open(scribe([windowDropped(2, skippable)]).pipe(Layer.provideMerge(shared))).pipe(Scope.provide(before))
    const session = yield* first.createSession({ owner: "learner" })
    yield* first.send(session, "One")
    yield* Scope.close(before, Exit.void)
    const agent = yield* open(memory.pipe(Layer.provideMerge(shared)))
    const sent = yield* Effect.result(agent.send(session, "Two"))
    const journal = (yield* agent.inspect(session)).events
    return { sent, journal, prompt: (yield* received).at(-1) }
  })))

  const expectSentAgain = (result: Awaited<ReturnType<typeof after>>, skippable = true) => {
    expect(result.journal.find((event) => event.name === "plugin.window.dropped")).toMatchObject({ seq: 3, skippable, tags: ["memory"], data: { through: 2 } })
    expect(result.sent).toMatchObject({ _tag: "Success", success: "Fine." })
    // "One", at 2, is sent again: nothing reads the window's record now.
    expect(result.prompt).toEqual([
      { role: "system", text: SYSTEM },
      { role: "user", text: "One" },
      { role: "assistant", text: "Fine." },
      { role: "user", text: "Two" },
    ])
  }

  test("the flat memory passes over its plugin.window.dropped record and sends the turns it had dropped", async () => {
    expectSentAgain(await after(flatMemory))
  })

  test("the summary memory passes over its plugin.window.dropped record and sends the turns it had dropped", async () => {
    const unasked = Layer.succeed(Summarizer, Summarizer.of({ summarize: () => Effect.die("the conversation fits: no summary is asked for") }))
    expectSentAgain(await after(Layer.provide(summaryMemory({ budgetTokens: 3000 }), unasked)))
  })

  test("the record is another plugin's to them, not one of their own they may skip: stored as not skippable, it is passed over all the same", async () => {
    const unasked = Layer.succeed(Summarizer, Summarizer.of({ summarize: () => Effect.die("the conversation fits: no summary is asked for") }))
    expectSentAgain(await after(flatMemory, false), false)
    expectSentAgain(await after(Layer.provide(summaryMemory({ budgetTokens: 3000 }), unasked), false), false)
  })
})

/*
 * The session's state is a fold of its journal, so a second session plugin
 * over the same storage finds it without having seen the turns.
 */
describe("a session plugin that meets a session it did not run", () => {
  /** Two session plugins over one storage. */
  const twoOverOneStore = Effect.gen(function* () {
    const shared = yield* Layer.build(Layer.provideMerge(inProcessJournal(), kernel()))
    const over = Layer.succeedContext(shared)
    const first = Context.get(yield* Layer.build(Layer.provide(sessions(), over)), Sessions)
    const second = Context.get(yield* Layer.build(Layer.provide(sessions(), over)), Sessions)
    return { first, second, storage: Context.get(shared, JournalStorage), core: Context.get(shared, Core) }
  })
  const owner = Owner.make("learner")

  test("numbers the next turn after the ones the journal holds, at the next place", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { first, second } = yield* twoOverOneStore
      const id = yield* first.create({ owner })
      yield* first.turn(id, () => Effect.void)
      yield* first.turn(id, () => Effect.void)
      const turn = yield* second.turn(id, (session) => Effect.succeed(Number(session.turn)))
      return { turn, seqs: (yield* second.read(id)).events.map((event): number => event.seq) }
    })))
    expect(result).toEqual({ turn: 3, seqs: [1, 2, 3, 4, 5, 6] })
  })

  test("refuses a turn while the journal says one is open", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { first, second } = yield* twoOverOneStore
      const id = yield* first.create({ owner })
      const open = yield* Deferred.make<void>()
      yield* Effect.forkScoped(first.turn(id, () => Effect.andThen(Deferred.succeed(open, undefined), Effect.never)))
      yield* Deferred.await(open)
      return yield* Effect.flip(second.turn(id, () => Effect.void))
    })))
    expect(result).toMatchObject({ _tag: "SessionRefused", reason: "SessionBusy" })
  })

  test("skips or refuses an unknown core record by its flag", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { first, second, storage } = yield* twoOverOneStore
      const skippable = yield* first.create({ owner })
      yield* first.turn(skippable, () => Effect.void)
      yield* storedByAnotherRelease(storage, skippable, sessionFuture(true))
      const unskippable = yield* first.create({ owner })
      yield* first.turn(unskippable, () => Effect.void)
      yield* storedByAnotherRelease(storage, unskippable, sessionFuture(false))
      return {
        skipped: yield* second.turn(skippable, (session) => Effect.succeed(Number(session.turn))),
        refused: yield* Effect.flip(second.turn(unskippable, () => Effect.void)),
        names: (yield* second.read(unskippable)).events.map((event): string => event.name),
      }
    })))
    expect(result.skipped).toBe(2)
    expect(result.refused).toMatchObject({ _tag: "UnknownRecord", name: "core.session.future", seq: 3 })
    // A session whose state cannot be read is not opened: nothing was stored for the refused turn.
    expect(result.names).toEqual(["core.session.turn.started", "core.session.turn.ended", "core.session.future"])
  })
})
