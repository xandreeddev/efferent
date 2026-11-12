import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Random, Ref, Schema } from "effect"
import type { Scope } from "effect"
import { Core, CoreLive, Owner, Sessions, Storage, StorageError, stored, storedEvent } from "@xandreed/core/kernel"
import type { StoredDraft } from "@xandreed/core/kernel"
import { inMemoryStorage } from "../storage-memory/storage.adapter.js"
import { sessions } from "./sessions.adapter.js"

const owner = Owner.make("learner")
const STARTED = "plugin.session.turn.started"
const ENDED = "plugin.session.turn.ended"
const noted = storedEvent("notes", "noted", { data: Schema.Struct({}), skippable: true })

/** What a storage double does with one append: let it through, refuse it, or die. */
type Fault = (event: StoredDraft) => Option.Option<Effect.Effect<never, StorageError>>
const through: Fault = () => Option.none()
/** Fail the appends of `name` with a storage error of `reason`. */
const failing = (name: string, reason: StorageError["reason"]): Fault => (event) =>
  event.name === name ? Option.some(Effect.fail(new StorageError({ reason, message: `the store was told to refuse ${name}` }))) : Option.none()
const dying = (name: string): Fault => (event) => event.name === name ? Option.some(Effect.die("the store broke")) : Option.none()

/**
 * The stock storage behind a double whose appends can be told to fail, and
 * as many session plugins over that one store as asked for.
 */
const over = (count: number) => Effect.gen(function* () {
  const below = yield* Layer.build(Layer.provideMerge(inMemoryStorage().layer, CoreLive()))
  const real = Context.get(below, Storage)
  const fault = yield* Ref.make<Fault>(through)
  const storage = Storage.of({
    ...real,
    append: (id, expectedSeq, event) => Effect.flatMap(Ref.get(fault), (decide) => Option.getOrElse(decide(event), () => real.append(id, expectedSeq, event))),
  })
  const parts = Layer.merge(Layer.succeed(Core, Context.get(below, Core)), Layer.succeed(Storage, storage))
  const plugins = yield* Effect.forEach(Array.from({ length: count }), () =>
    Effect.map(Layer.build(Layer.provide(Layer.fresh(sessions().layer), parts)), (built) => Context.get(built, Sessions)), { concurrency: 1 })
  const names = (id: Parameters<typeof real.read>[0]) => Effect.map(real.read(id), (journal) => journal.events.map((event): string => event.name))
  return { plugins, fault: (next: Fault) => Ref.set(fault, next), names }
})

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

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
    expect(result.failed).toMatchObject({ _tag: "StorageError", reason: "Unavailable" })
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
    expect(result.failed).toMatchObject({ _tag: "StorageError", reason: "Unavailable" })
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
  test("is a version 4 UUID minted from Effect's Random: a seeded run mints the same ids, and no secure context is asked for", async () => {
    const mint = (seed: string) => run(Effect.gen(function* () {
      const { plugins: [turns] } = yield* over(1)
      if (turns === undefined) return yield* Effect.die("no session plugin")
      return [yield* turns.create({ owner }), yield* turns.create({ owner })].map(String)
    }).pipe(Random.withSeed(seed)))
    const [first, again, other] = [await mint("a seed"), await mint("a seed"), await mint("another seed")]
    expect(first).toEqual(again)
    expect(first).not.toEqual(other)
    expect(new Set(first).size).toBe(2)
    for (const id of [...first, ...other]) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
