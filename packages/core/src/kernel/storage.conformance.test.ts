import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import type { SessionId } from "./ids.entity.js"
import { StorageError } from "./journal.entity.js"
import type { Journal } from "./journal.entity.js"
import { storageConformance } from "./storage.conformance.js"
import type { StorageSubject } from "./storage.conformance.js"
import { Storage } from "./storage.port.js"

/*
 * The kernel ships no storage yet. Here the kit runs over a store written
 * in the test, which passes it, and over careless ones, to show that no
 * check passes on a store that keeps nothing and that each refusal is
 * checked.
 */

type Journals = ReadonlyMap<SessionId, Journal>
/** What a write decided: its answer, and the journals after it. */
type Written = readonly [Effect.Effect<void, StorageError>, Journals]

const missing = (id: SessionId) => new StorageError({ reason: "SessionMissing", message: `no session ${id}` })

/** A store that keeps its promises, in a map. */
const honest: StorageSubject = {
  open: Effect.map(Ref.make<Journals>(new Map()), (journals) => Storage.of({
    create: (header) => Ref.modify(journals, (all): Written => all.has(header.id)
      ? [Effect.fail(new StorageError({ reason: "SessionExists", message: `session ${header.id} exists` })), all]
      : [Effect.void, new Map([...all, [header.id, { header, events: [] }]])]).pipe(Effect.flatten),
    append: (id, expectedSeq, events) => Ref.modify(journals, (all): Written => {
      const journal = all.get(id)
      if (journal === undefined) return [Effect.fail(missing(id)), all]
      return journal.events.length === expectedSeq
        ? [Effect.void, new Map([...all, [id, { header: journal.header, events: [...journal.events, ...events] }]])]
        : [Effect.fail(new StorageError({ reason: "SeqConflict", message: `the journal is at ${journal.events.length}, not ${expectedSeq}` })), all]
    }).pipe(Effect.flatten),
    read: (id, from) => Effect.flatMap(Ref.get(journals), (all) => {
      const journal = all.get(id)
      return journal === undefined ? Effect.fail(missing(id))
        : Effect.succeed({ header: journal.header, events: journal.events.filter((event) => from === undefined || event.seq >= from) })
    }),
  })),
}

/** A store that accepts every write and keeps none of it. */
const forgetful: StorageSubject = {
  open: Effect.succeed(Storage.of({
    create: () => Effect.void,
    append: () => Effect.void,
    read: (id) => Effect.fail(missing(id)),
  })),
}

/** A store that never refuses: a second create starts over, an append lands wherever, an unknown session reads as an empty one, a read ignores its place. */
const trusting: StorageSubject = {
  open: Effect.map(Ref.make<Journals>(new Map()), (journals) => Storage.of({
    create: (header) => Ref.update(journals, (all) => new Map([...all, [header.id, { header, events: [] }]])),
    append: (id, _expectedSeq, events) => Ref.update(journals, (all) => {
      const journal = all.get(id)
      return journal === undefined ? all : new Map([...all, [id, { header: journal.header, events: [...journal.events, ...events] }]])
    }),
    read: (id) => Effect.flatMap(Ref.get(journals), (all) => {
      const any = all.get(id) ?? Array.from(all.values())[0]
      return any === undefined ? Effect.fail(missing(id)) : Effect.succeed(all.get(id) ?? { header: any.header, events: [] })
    }),
  })),
}

const failedChecks = (subject: StorageSubject) => Effect.runPromise(Effect.forEach(storageConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])))).then((failed) => failed.flat().toSorted())

const everyCheck = ["append", "conflict", "create", "missing", "read-from"]

describe("the storage kit", () => {
  test("its checks have the ids its doc comment lists", () => {
    expect(storageConformance(honest).length).toBe(everyCheck.length)
  })

  test("a store that keeps its promises passes every check", async () => {
    expect(await failedChecks(honest)).toEqual([])
  })

  test("a store that keeps nothing fails every check", async () => {
    expect(await failedChecks(forgetful)).toEqual(everyCheck)
  })

  test("a store that never refuses fails every check of a refusal or a place", async () => {
    expect(await failedChecks(trusting)).toEqual(["conflict", "create", "missing", "read-from"])
  })
})
