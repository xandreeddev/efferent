import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { dataOf, JournalStorage, kernel, Owner, Seq, SessionId, Sessions, turnEndedEvent, turnStarted, TurnNumber } from "@xandreed/core/kernel"
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
      const closed = yield* recoverTurns
      const again = yield* recoverTurns
      const ends = yield* Effect.forEach([conversation, helper, free, later], (id) => Effect.map(all.read(id), (journal) =>
        journal.events.flatMap((event) => Option.toArray(Option.map(dataOf(turnEndedEvent, event), (data) => data.outcome._tag)))), { concurrency: 1 })
      // Sessions made in one millisecond are listed by id, which is random: the turns closed are compared as a set.
      const named = closed.map((one) => [one.session === conversation ? "conversation" : one.session === helper ? "helper" : String(one.session), Number(one.turn)] as const)
      return { closed: named.toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), again, ends }
    }).pipe(Effect.provide(sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))))))
    expect(result).toEqual({
      closed: [["conversation", 1], ["helper", 1]],
      again: [],
      ends: [["Abandoned"], ["Abandoned"], ["Completed"], []],
    })
  })
})
