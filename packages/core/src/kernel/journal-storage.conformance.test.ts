import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Ref } from "effect"
import type { StoredEvent } from "./event.entity.js"
import { Owner, Seq, TurnNumber } from "./ids.entity.js"
import type { SessionId } from "./ids.entity.js"
import { JournalStorageError } from "./journal.entity.js"
import type { Journal } from "./journal.entity.js"
import { JOURNAL_FORMAT } from "./session.entity.js"
import { byCreation } from "./session.entity.functions.js"
import { journalStorageConformance } from "./journal-storage.conformance.js"
import type { JournalStorageSubject } from "./journal-storage.conformance.js"
import { JournalStorage } from "./journal-storage.port.js"

/*
 * Core ships no storage. Here the kit runs over a store written in the
 * test, which passes it, and over careless ones, to show that no check
 * passes on a store that keeps nothing and that each refusal is checked.
 * The kit runs over the stock storage plugin where that plugin lives.
 */

type Journals = ReadonlyMap<SessionId, Journal>
/** What a write decided: its answer, and the journals after it. */
type Decided<A> = readonly [Effect.Effect<A, JournalStorageError>, Journals]

const missing = (id: SessionId) => new JournalStorageError({ reason: "SessionMissing", message: `no session ${id}` })

/** A handle on journals kept in a ref: a store that keeps its promises. */
const handleOn = (journals: Ref.Ref<Journals>) => JournalStorage.of({
    create: (header) => Ref.modify(journals, (all): Decided<void> => all.has(header.id)
      ? [Effect.fail(new JournalStorageError({ reason: "SessionExists", message: `session ${header.id} exists` })), all]
      : [Effect.void, new Map([...all, [header.id, { header, events: [] }]])]).pipe(Effect.flatten),
    append: (id, expectedSeq, turn, event) => Ref.modify(journals, (all): Decided<StoredEvent> => {
      const journal = all.get(id)
      if (journal === undefined) return [Effect.fail(missing(id)), all]
      if (journal.events.length !== expectedSeq) return [Effect.fail(new JournalStorageError({ reason: "SeqConflict", message: `the journal is at ${journal.events.length}, not ${expectedSeq}` })), all]
      const stored: StoredEvent = { seq: Seq.make(expectedSeq + 1), at: 1_767_225_600_000, turn, ...event }
      return [Effect.succeed(stored), new Map([...all, [id, { header: journal.header, events: [...journal.events, stored] }]])]
    }).pipe(Effect.flatten),
    read: (id, from) => Effect.flatMap(Ref.get(journals), (all) => {
      const journal = all.get(id)
      return journal === undefined ? Effect.fail(missing(id))
        : Effect.succeed({ header: journal.header, events: journal.events.filter((event) => from === undefined || event.seq >= from) })
    }),
    list: Effect.map(Ref.get(journals), (all) => Arr.sort(Array.from(all.values(), (journal) => journal.header), byCreation)),
})

/** A store that keeps its promises, in a map; its pair is two handles on one map. */
const honest: JournalStorageSubject = {
  open: Effect.map(Ref.make<Journals>(new Map()), handleOn),
  pair: Effect.map(Ref.make<Journals>(new Map()), (journals) => [handleOn(journals), handleOn(journals)] as const),
}

/** A store that accepts every write, stamps it as asked and keeps none of it. */
const forgetful: JournalStorageSubject = {
  open: Effect.succeed(JournalStorage.of({
    create: () => Effect.void,
    append: (_id, expectedSeq, turn, event) => Effect.succeed({ seq: Seq.make(expectedSeq + 1), at: 0, turn, ...event }),
    read: (id) => Effect.fail(missing(id)),
    list: Effect.succeed([]),
  })),
}

/** A store that never refuses: a second create starts over, an append lands wherever, an unknown session reads as an empty one, a read ignores its place. */
const trusting: JournalStorageSubject = {
  open: Effect.map(Ref.make<Journals>(new Map()), (journals) => JournalStorage.of({
    create: (header) => Ref.update(journals, (all) => new Map([...all, [header.id, { header, events: [] }]])),
    append: (id, _expectedSeq, turn, event) => Ref.modify(journals, (all) => {
      const journal = all.get(id) ?? { header: { id, owner: Owner.make("nobody"), createdAt: 0, format: JOURNAL_FORMAT }, events: [] }
      const stored: StoredEvent = { seq: Seq.make(journal.events.length + 1), at: 0, turn, ...event }
      return [stored, new Map([...all, [id, { header: journal.header, events: [...journal.events, stored] }]])] as const
    }),
    read: (id) => Effect.map(Ref.get(journals), (all) => all.get(id) ?? { header: { id, owner: Owner.make("nobody"), createdAt: 0, format: JOURNAL_FORMAT }, events: [] }),
    list: Effect.map(Ref.get(journals), (all) => Arr.sort(Array.from(all.values(), (journal) => journal.header), byCreation)),
  })),
}

/** A store that stamps every event with the first turn, whatever turn it was appended in. */
const unturned: JournalStorageSubject = {
  open: Effect.map(honest.open, (storage) => JournalStorage.of({
    ...storage,
    append: (id, expectedSeq, _turn, event) => storage.append(id, expectedSeq, TurnNumber.make(1), event),
  })),
}

/** A store that stamps every event with the same place. */
const unnumbering: JournalStorageSubject = {
  open: Effect.map(honest.open, (storage) => JournalStorage.of({
    ...storage,
    append: (id, expectedSeq, turn, event) => Effect.map(storage.append(id, expectedSeq, turn, event), (stored) => ({ ...stored, seq: Seq.make(1) })),
  })),
}

/** A store with a column for the id and one for the owner, and no other: a header reads back without its parent. */
const headless: JournalStorageSubject = {
  open: Effect.map(honest.open, (storage) => JournalStorage.of({
    ...storage,
    read: (id, from) => Effect.map(storage.read(id, from), (journal) => ({ header: { id: journal.header.id, owner: journal.header.owner, createdAt: journal.header.createdAt, format: JOURNAL_FORMAT }, events: journal.events })),
  })),
}

/** A store that writes its own format on every header, whatever it was given. */
const reformatting: JournalStorageSubject = {
  open: Effect.map(honest.open, (storage) => JournalStorage.of({
    ...storage,
    read: (id, from) => Effect.map(storage.read(id, from), (journal) => ({ header: { ...journal.header, format: journal.header.format + 1 }, events: journal.events })),
  })),
}

/** A store that restamps the time a session was created at with a time of its own, the same for all. */
const redated: JournalStorageSubject = {
  open: Effect.map(honest.open, (storage) => JournalStorage.of({
    ...storage,
    create: (header) => storage.create({ ...header, createdAt: 5 }),
  })),
}

/** A store that lists its sessions in the order they were created in, whatever their headers say. */
const insertionOrdered: JournalStorageSubject = {
  open: Effect.map(Ref.make<ReadonlyArray<SessionId>>([]), (order) => {
    const journals = Effect.runSync(Ref.make<Journals>(new Map()))
    const storage = handleOn(journals)
    return JournalStorage.of({
      ...storage,
      create: (header) => Effect.tap(storage.create(header), () => Ref.update(order, (ids) => [...ids, header.id])),
      list: Effect.flatMap(Ref.get(order), (ids) => Effect.map(Ref.get(journals), (all) => ids.flatMap((id) => { const journal = all.get(id); return journal === undefined ? [] : [journal.header] }))),
    })
  }),
}

/** A store that lists only the sessions something was appended to. */
const listingWritten: JournalStorageSubject = {
  open: Effect.map(honest.open, (storage) => JournalStorage.of({
    ...storage,
    list: Effect.flatMap(storage.list, (headers) => Effect.map(
      Effect.forEach(headers, (header) => Effect.map(storage.read(header.id), (journal) => journal.events.length > 0 ? [header] : []), { concurrency: 1 }),
      (kept) => kept.flat(),
    )),
  })),
}

/** A store whose handles each keep their events in memory: a second handle finds the headers of the first, and none of its events. */
const forgetsOnReopen: JournalStorageSubject = {
  open: honest.open,
  pair: Effect.map(Ref.make<Journals>(new Map()), (shared) => {
    const handle = () => {
      const own = Effect.runSync(Ref.make<Journals>(new Map()))
      const mine = handleOn(own)
      return JournalStorage.of({
        ...mine,
        create: (header) => Effect.andThen(handleOn(shared).create(header), Effect.ignore(mine.create(header), { log: "Debug", message: "created through the other handle" })),
        read: (id, from) => Effect.catchTag(mine.read(id, from), "JournalStorageError", () => handleOn(shared).read(id, from)),
        append: (id, expectedSeq, turn, event) => Effect.flatMap(
          Effect.ignore(Effect.flatMap(handleOn(shared).read(id), (journal) => mine.create(journal.header)), { log: "Debug", message: "known to this handle already" }),
          () => mine.append(id, expectedSeq, turn, event),
        ),
        list: handleOn(shared).list,
      })
    }
    return [handle(), handle()] as const
  }),
}

/** The ids of the checks that fail; a failure that names another check than the one it came from is told apart. */
const failedChecks = (subject: JournalStorageSubject) => Effect.runPromise(Effect.forEach(journalStorageConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check === check.id ? check.id : `${check.id} reported as ${result.failure.check}`] : [])))).then((failed) => failed.flat().toSorted())

const everyCheck = ["append", "conflict", "create", "list", "missing", "read-from"]

describe("the storage kit", () => {
  test("its checks have the ids its doc comment lists, in that order", () => {
    expect(journalStorageConformance(honest).map((check) => check.id)).toEqual(["create", "append", "conflict", "read-from", "missing", "list", "reopens"])
    // A store with no medium beside its handle gives no pair, and is not asked what a second handle reads.
    expect(journalStorageConformance({ open: honest.open }).map((check) => check.id)).toEqual(["create", "append", "conflict", "read-from", "missing", "list"])
  })

  test("a store that keeps its promises passes every check", async () => {
    expect(await failedChecks(honest)).toEqual([])
  })

  test("a store that keeps nothing fails every check", async () => {
    expect(await failedChecks(forgetful)).toEqual(everyCheck)
  })

  test("a store that never refuses fails every check of a refusal or a place", async () => {
    expect(await failedChecks(trusting)).toEqual(["conflict", "create", "list", "missing", "read-from"])
  })

  test("a store that loses a header's parent, or rewrites its format, fails the check of a creation", async () => {
    expect(await failedChecks(headless)).toEqual(["create"])
    expect(await failedChecks(reformatting)).toEqual(["create"])
  })

  test("a store that restamps a header's creation time fails the checks of a creation and of the list", async () => {
    expect(await failedChecks(redated)).toEqual(["create", "list"])
  })

  test("a store that lists in the order of creation calls, or lists only what was written to, fails the check of the list", async () => {
    expect(await failedChecks(insertionOrdered)).toEqual(["list"])
    expect(await failedChecks(listingWritten)).toEqual(["list"])
  })

  test("a store whose second handle does not read what the first wrote fails the check of a reopening", async () => {
    expect(await failedChecks(forgetsOnReopen)).toEqual(["reopens"])
  })

  test("a store that does not stamp the next place fails the check of an append", async () => {
    expect(await failedChecks(unnumbering)).toEqual(["append"])
  })

  test("a store that stamps every event with the first turn fails the check of an append", async () => {
    expect(await failedChecks(unturned)).toEqual(["append"])
  })
})
