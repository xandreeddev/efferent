import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import type { StoredEvent } from "./event.entity.js"
import { Owner, Seq } from "./ids.entity.js"
import type { SessionId } from "./ids.entity.js"
import { StorageError } from "./journal.entity.js"
import type { Journal } from "./journal.entity.js"
import { JOURNAL_FORMAT } from "./session.entity.js"
import { storageConformance } from "./storage.conformance.js"
import type { StorageSubject } from "./storage.conformance.js"
import { Storage } from "./storage.port.js"

/*
 * Core ships no storage. Here the kit runs over a store written in the
 * test, which passes it, and over careless ones, to show that no check
 * passes on a store that keeps nothing and that each refusal is checked.
 * The kit runs over the stock storage plugin where that plugin lives.
 */

type Journals = ReadonlyMap<SessionId, Journal>
/** What a write decided: its answer, and the journals after it. */
type Decided<A> = readonly [Effect.Effect<A, StorageError>, Journals]

const missing = (id: SessionId) => new StorageError({ reason: "SessionMissing", message: `no session ${id}` })

/** A store that keeps its promises, in a map. */
const honest: StorageSubject = {
  open: Effect.map(Ref.make<Journals>(new Map()), (journals) => Storage.of({
    create: (header) => Ref.modify(journals, (all): Decided<void> => all.has(header.id)
      ? [Effect.fail(new StorageError({ reason: "SessionExists", message: `session ${header.id} exists` })), all]
      : [Effect.void, new Map([...all, [header.id, { header, events: [] }]])]).pipe(Effect.flatten),
    append: (id, expectedSeq, event) => Ref.modify(journals, (all): Decided<StoredEvent> => {
      const journal = all.get(id)
      if (journal === undefined) return [Effect.fail(missing(id)), all]
      if (journal.events.length !== expectedSeq) return [Effect.fail(new StorageError({ reason: "SeqConflict", message: `the journal is at ${journal.events.length}, not ${expectedSeq}` })), all]
      const stored: StoredEvent = { seq: Seq.make(expectedSeq + 1), at: 1_767_225_600_000, ...event }
      return [Effect.succeed(stored), new Map([...all, [id, { header: journal.header, events: [...journal.events, stored] }]])]
    }).pipe(Effect.flatten),
    read: (id, from) => Effect.flatMap(Ref.get(journals), (all) => {
      const journal = all.get(id)
      return journal === undefined ? Effect.fail(missing(id))
        : Effect.succeed({ header: journal.header, events: journal.events.filter((event) => from === undefined || event.seq >= from) })
    }),
  })),
}

/** A store that accepts every write, stamps it as asked and keeps none of it. */
const forgetful: StorageSubject = {
  open: Effect.succeed(Storage.of({
    create: () => Effect.void,
    append: (_id, expectedSeq, event) => Effect.succeed({ seq: Seq.make(expectedSeq + 1), at: 0, ...event }),
    read: (id) => Effect.fail(missing(id)),
  })),
}

/** A store that never refuses: a second create starts over, an append lands wherever, an unknown session reads as an empty one, a read ignores its place. */
const trusting: StorageSubject = {
  open: Effect.map(Ref.make<Journals>(new Map()), (journals) => Storage.of({
    create: (header) => Ref.update(journals, (all) => new Map([...all, [header.id, { header, events: [] }]])),
    append: (id, _expectedSeq, event) => Ref.modify(journals, (all) => {
      const journal = all.get(id) ?? { header: { id, owner: Owner.make("nobody"), format: JOURNAL_FORMAT }, events: [] }
      const stored: StoredEvent = { seq: Seq.make(journal.events.length + 1), at: 0, ...event }
      return [stored, new Map([...all, [id, { header: journal.header, events: [...journal.events, stored] }]])] as const
    }),
    read: (id) => Effect.map(Ref.get(journals), (all) => all.get(id) ?? { header: { id, owner: Owner.make("nobody"), format: JOURNAL_FORMAT }, events: [] }),
  })),
}

/** A store that stamps every event with the same place. */
const unnumbering: StorageSubject = {
  open: Effect.map(honest.open, (storage) => Storage.of({
    ...storage,
    append: (id, expectedSeq, event) => Effect.map(storage.append(id, expectedSeq, event), (stored) => ({ ...stored, seq: Seq.make(1) })),
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

  test("a store that does not stamp the next place fails the check of an append", async () => {
    expect(await failedChecks(unnumbering)).toEqual(["append"])
  })
})
