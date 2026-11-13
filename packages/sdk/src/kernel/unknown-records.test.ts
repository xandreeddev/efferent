import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { Core, EventName, JournalStorage, kernel, messageOf, Owner, Seq, Sessions, stored, storedEvent, TurnNumber, userMessageEvent } from "@xandreed/core/kernel"
import type { SessionId, StoredDraft } from "@xandreed/core/kernel"
import { Memory } from "./contracts/memory/memory.port.js"
import { inProcessJournal, promptMessage, sessions, windowMemory } from "./index.js"
import { answering, base, open } from "./testing.js"

/*
 * Records a later release of a plugin might write, which this one does not
 * know: one under the window memory's prefix, one under core's, where the
 * session's records are. Each says whether a reader that does not know it
 * may skip it.
 */
const windowFuture = (skippable: boolean) => stored(storedEvent("window", "future", { tags: ["memory"], data: Schema.Struct({ note: Schema.String }), skippable }), { note: "from a later release" })
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
const scribe = (records: ReadonlyArray<ReturnType<typeof windowFuture>>): Layer.Layer<Memory> => Layer.succeed(Memory, Memory.of({
  context: (session) => Effect.gen(function* () {
    yield* Effect.forEach(records, (record) => session.append(record), { concurrency: 1, discard: true })
    const journal = yield* session.journal
    return journal.filter((event) => event.name === userMessageEvent.name).slice(-1).flatMap((event) => Option.toArray(messageOf(event))).map(promptMessage)
  }),
}))

/**
 * One turn under a memory that leaves `records` in the journal, then the stock window memory over that journal: the
 * same base, a stack above it each. Records under `core.` are stored after that turn, as another release of the
 * session plugin would store them.
 */
const windowAfter = (records: ReadonlyArray<ReturnType<typeof windowFuture>>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
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
  const agent = yield* open(windowMemory({ budgetTokens: 3000 }).pipe(Layer.provideMerge(shared)))
  const sent = yield* Effect.result(agent.send(session, "Two"))
  const inspected = yield* Effect.result(agent.inspect(session))
  return { sent, inspected }
})))

describe("a stored plugin record a reader does not know", () => {
  test("is skipped by the window memory when the record says it may be", async () => {
    const result = await windowAfter([windowFuture(true)])
    expect(result.sent).toMatchObject({ _tag: "Success", success: "Fine." })
    expect(result.inspected).toMatchObject({ _tag: "Success", success: { state: { _tag: "Free", turns: 2 } } })
  })

  test("is refused by the window memory with a typed error when it may not be, and the turn still closes", async () => {
    const result = await windowAfter([windowFuture(false)])
    expect(result.sent).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownRecord", name: "plugin.window.future", seq: 3 } })
    const inspection = result.inspected._tag === "Success" ? result.inspected.success : undefined
    expect(inspection?.events.map((event): string => event.name).slice(5)).toEqual(["core.session.turn.started", "conversation.user.message", "core.session.turn.ended"])
    expect(inspection?.events.at(-1)?.data).toMatchObject({ outcome: { _tag: "Failed" } })
  })

  test("is no concern of a reader whose prefixes it is not under, whatever it says", async () => {
    const result = await windowAfter([stranger])
    expect(result.sent).toMatchObject({ _tag: "Success", success: "Fine." })
    expect(result.inspected).toMatchObject({ _tag: "Success" })
  })

  test("under core's prefix: skipped by the readers of the session's state when it may be, refused when it may not", async () => {
    const skipped = await windowAfter([sessionFuture(true)])
    expect(skipped.sent).toMatchObject({ _tag: "Success", success: "Fine." })
    expect(skipped.inspected).toMatchObject({ _tag: "Success", success: { state: { _tag: "Free", turns: 2 } } })
    const refused = await windowAfter([sessionFuture(false)])
    // The window memory answers for `core.` too, and so does whoever folds the journal to a state.
    expect(refused.sent).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownRecord", name: "core.session.future" } })
    expect(refused.inspected).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownRecord", name: "core.session.future" } })
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
