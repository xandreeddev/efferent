import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Core, CoreLive, definePlugin, estimateRequest, Memory, Sessions, Settings, Owner, JournalStorage, stored, storedEvent, Tokens } from "@xandreed/core/kernel"
import type { Plugin } from "@xandreed/core/kernel"
import { Agent, inProcessJournal, sessions, windowMemory } from "./index.js"
import { answering } from "./testing.js"

const system = "You are a friendly tutor."

/*
 * Records a later release of a plugin might write, which this one does not
 * know: one under the window memory's prefix, one under the session
 * plugin's. Each says whether a reader that does not know it may skip it.
 */
const windowFuture = (skippable: boolean) => stored(storedEvent("window", "future", { data: Schema.Struct({ note: Schema.String }), skippable }), { note: "from a later release" })
const sessionFuture = (skippable: boolean) => stored(storedEvent("session", "future", { data: Schema.Struct({}), skippable }), {})
/** Another plugin's record, which may not be skipped by those it concerns. */
const stranger = stored(storedEvent("elsewhere", "noted", { data: Schema.Struct({}), skippable: false }), {})

/** A memory that sends nothing but the turn's message and, before that, writes `records` into the journal. */
const scribe = (records: ReadonlyArray<ReturnType<typeof windowFuture>>): Plugin<Memory, never, Settings> => definePlugin({
  name: "scribe",
  requires: [Settings],
  provides: Memory,
  make: Effect.map(Settings, (settings) => Memory.of({
    build: (session) => Effect.gen(function* () {
      yield* Effect.forEach(records, (record) => session.append(record), { concurrency: 1, discard: true })
      const journal = yield* session.journal
      const asked = journal.filter((event) => event.name === "plugin.loop.user.message").slice(-1)
      return { messages: asked.map((event) => event.seq), estimatedTokens: estimateRequest(settings.system, asked.flatMap((event) => event.message === undefined ? [] : [event.message])), budgetTokens: Tokens.make(3000) }
    }),
  })),
})

/** One turn under a memory that leaves `records` in the journal, then the stock window memory over that journal. */
const windowAfter = (records: ReadonlyArray<ReturnType<typeof windowFuture>>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model } = yield* answering("Fine.")
  const first = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: scribe(records) })
  const session = yield* first.createSession({ owner: "learner" })
  yield* first.send(session, "One")
  const agent = yield* first.with({ memory: windowMemory({ budgetTokens: 3000 }) })
  const sent = yield* Effect.result(agent.send(session, "Two"))
  const inspected = yield* Effect.result(agent.inspect(session))
  return { sent, inspected }
})))

describe("a stored plugin record a reader does not know", () => {
  test("is skipped by the window memory when the record says it may be", async () => {
    const result = await windowAfter([windowFuture(true)])
    expect(result.sent).toMatchObject({ _tag: "Success", success: { text: "Fine." } })
    expect(result.inspected).toMatchObject({ _tag: "Success", success: { state: { _tag: "Free", turns: 2 } } })
  })

  test("is refused by the window memory with a typed error when it may not be, and the turn still closes", async () => {
    const result = await windowAfter([windowFuture(false)])
    expect(result.sent).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownRecord", name: "plugin.window.future", seq: 3 } })
    const inspection = result.inspected._tag === "Success" ? result.inspected.success : undefined
    expect(inspection?.events.map((event): string => event.name).slice(6)).toEqual(["plugin.session.turn.started", "plugin.loop.user.message", "plugin.session.turn.ended"])
    expect(inspection?.events.at(-1)?.data).toMatchObject({ outcome: { _tag: "Failed" } })
  })

  test("is no concern of a reader whose prefixes it is not under, whatever it says", async () => {
    const result = await windowAfter([stranger])
    expect(result.sent).toMatchObject({ _tag: "Success", success: { text: "Fine." } })
    expect(result.inspected).toMatchObject({ _tag: "Success" })
  })

  test("under the session plugin's prefix: skipped by the readers of the session's state when it may be, refused when it may not", async () => {
    const skipped = await windowAfter([sessionFuture(true)])
    expect(skipped.sent).toMatchObject({ _tag: "Success", success: { text: "Fine." } })
    expect(skipped.inspected).toMatchObject({ _tag: "Success", success: { state: { _tag: "Free", turns: 2 } } })
    const refused = await windowAfter([sessionFuture(false)])
    // The window memory answers for `plugin.session.` too, and so does whoever folds the journal to a state.
    expect(refused.sent).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownRecord", name: "plugin.session.future" } })
    expect(refused.inspected).toMatchObject({ _tag: "Failure", failure: { _tag: "UnknownRecord", name: "plugin.session.future" } })
  })
})

/*
 * The session's state is a fold of its journal, so a second session plugin
 * over the same storage finds it without having seen the turns.
 */
describe("a session plugin that meets a session it did not run", () => {
  /** Two session plugins over one storage. */
  const twoOverOneStore = Effect.gen(function* () {
    const shared = yield* Layer.build(Layer.provideMerge(inProcessJournal().layer, CoreLive()))
    const over = Layer.succeedContext(shared)
    const first = Context.get(yield* Layer.build(Layer.provide(Layer.fresh(sessions().layer), over)), Sessions)
    const second = Context.get(yield* Layer.build(Layer.provide(Layer.fresh(sessions().layer), over)), Sessions)
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

  test("skips or refuses an unknown record of the session plugin by its flag", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { first, second } = yield* twoOverOneStore
      const skippable = yield* first.create({ owner })
      yield* first.turn(skippable, (session) => session.append(sessionFuture(true)))
      const unskippable = yield* first.create({ owner })
      yield* first.turn(unskippable, (session) => session.append(sessionFuture(false)))
      return {
        skipped: yield* second.turn(skippable, (session) => Effect.succeed(Number(session.turn))),
        refused: yield* Effect.flip(second.turn(unskippable, () => Effect.void)),
        names: (yield* second.read(unskippable)).events.map((event): string => event.name),
      }
    })))
    expect(result.skipped).toBe(2)
    expect(result.refused).toMatchObject({ _tag: "UnknownRecord", name: "plugin.session.future", seq: 2 })
    // A session whose state cannot be read is not opened: nothing was stored for the refused turn.
    expect(result.names).toEqual(["plugin.session.turn.started", "plugin.session.future", "plugin.session.turn.ended"])
  })
})
