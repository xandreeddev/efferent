import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { dataOf, JOURNAL_FORMAT, JournalStorage, JournalStorageError, kernel, Owner, Seq, SessionId, Sessions, turnEndedEvent, turnStarted, TurnNumber } from "@xandreed/core/kernel"
import { inProcessJournal } from "../journal-in-process/journal.adapter.js"
import { sessions } from "./sessions.adapter.js"
import { recoverTurns } from "./recover.usecase.js"

/*
 * The host's recovery step: every turn a store holds open is closed as
 * abandoned, in every session it reads, and a session of another journal
 * format is passed over.
 */

describe("recoverTurns", () => {
  test("closes every turn the store holds open, in every session it reads, and passes over one of another format", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const all = yield* Sessions
      const storage = yield* JournalStorage
      const conversation = yield* all.create({ owner: "learner" })
      const helper = yield* all.create({ owner: "learner", parent: conversation })
      const free = yield* all.create({ owner: "plugin.facts" })
      yield* all.turn(free, () => Effect.void)
      const later = SessionId.make("from-a-later-kernel")
      yield* storage.create({ id: later, owner: Owner.make("learner"), createdAt: 0, format: 99 })
      // What writers that died inside their turns left: a start, and no end.
      yield* Effect.forEach([conversation, helper, later], (id) => storage.append(id, Seq.make(0), TurnNumber.make(1), turnStarted(TurnNumber.make(1))), { concurrency: 1, discard: true })
      const { closed, unreadable } = yield* recoverTurns
      const again = yield* recoverTurns
      const ends = yield* Effect.forEach([conversation, helper, free, later], (id) => Effect.map(all.read(id), (journal) =>
        journal.events.flatMap((event) => Option.toArray(Option.map(dataOf(turnEndedEvent, event), (data) => data.outcome._tag)))), { concurrency: 1 })
      // Sessions made in one millisecond are listed by id, which is random: the turns closed are compared as a set.
      const named = closed.map((one) => [one.session === conversation ? "conversation" : one.session === helper ? "helper" : String(one.session), Number(one.turn)] as const)
      return { closed: named.toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), unreadable, again, ends }
    }).pipe(Effect.provide(sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))))))
    expect(result).toEqual({
      closed: [["conversation", 1], ["helper", 1]],
      unreadable: [],
      again: { closed: [], unreadable: [] },
      ends: [["Abandoned"], ["Abandoned"], ["Completed"], []],
    })
  })

  test("passes over a session the store cannot read, says which, and closes the turns of the sessions after it", async () => {
    // A store whose read of one session fails as a damaged line does; every other call is the journal's own.
    const damaged = SessionId.make("b-damaged")
    const store = Layer.effect(JournalStorage, Effect.map(JournalStorage, (inner) => JournalStorage.of({
      ...inner,
      read: (id, from) => id === damaged
        ? Effect.fail(new JournalStorageError({ reason: "Unreadable", message: `session ${id}: line 3 is not the line that was written` }))
        : inner.read(id, from),
    }))).pipe(Layer.provide(inProcessJournal()))
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const storage = yield* JournalStorage
      // Three sessions in the order of `list`: one before the damaged one, the damaged one, one after; each with a turn left open.
      const ids = ["a-before", "b-damaged", "c-after"].map((id) => SessionId.make(id))
      yield* Effect.forEach(ids, (id, index) => Effect.andThen(
        storage.create({ id, owner: Owner.make("learner"), createdAt: index, format: JOURNAL_FORMAT }),
        storage.append(id, Seq.make(0), TurnNumber.make(1), turnStarted(TurnNumber.make(1))),
      ), { concurrency: 1, discard: true })
      const recovery = yield* recoverTurns
      const all = yield* Sessions
      const after = yield* all.turn(ids[2] ?? damaged, (session) => Effect.succeed(session.turn))
      return { recovery, after }
    }).pipe(Effect.provide(sessions().pipe(Layer.provideMerge(store), Layer.provideMerge(kernel()))))))
    expect<unknown>(result).toEqual({
      recovery: {
        closed: [{ session: "a-before", turn: 1 }, { session: "c-after", turn: 1 }],
        unreadable: [{ session: "b-damaged", message: "session b-damaged: line 3 is not the line that was written" }],
      },
      after: 2,
    })
  })

  test("a store that cannot be reached still fails the step", async () => {
    const store = Layer.effect(JournalStorage, Effect.map(JournalStorage, (inner) => JournalStorage.of({
      ...inner,
      read: () => Effect.fail(new JournalStorageError({ reason: "Unavailable", message: "the disk is gone" })),
    }))).pipe(Layer.provide(inProcessJournal()))
    const failure = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const storage = yield* JournalStorage
      yield* storage.create({ id: SessionId.make("a"), owner: Owner.make("learner"), createdAt: 0, format: JOURNAL_FORMAT })
      return yield* Effect.flip(recoverTurns)
    }).pipe(Effect.provide(sessions().pipe(Layer.provideMerge(store), Layer.provideMerge(kernel()))))))
    expect(failure).toMatchObject({ _tag: "JournalStorageError", reason: "Unavailable" })
  })
})
