import { Effect } from "effect"
import type { Context, Scope } from "effect"
import { expect, fail, show } from "./conformance.entity.functions.js"
import type { ConformanceCheck, ConformanceFailure } from "./conformance.entity.js"
import { Schema } from "effect"
import { stored, storedEvent } from "./event.entity.functions.js"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import { Owner, Seq, SessionId, TurnNumber } from "./ids.entity.js"
import type { JournalStorageError } from "./journal.entity.js"
import { JOURNAL_FORMAT } from "./session.entity.js"
import type { SessionHeader } from "./session.entity.js"
import type { JournalStorage } from "./journal-storage.port.js"

type JournalStorageShape = Context.Service.Shape<typeof JournalStorage>

/**
 * A storage backend as the kit opens it: an empty one per check, released
 * with its scope. A store whose journals outlive the handle that wrote
 * them (a file, a database, a browser's storage) also gives `pair`: two
 * handles on one empty medium, and the kit checks that the second reads
 * what the first wrote (`reopens`). A store that is its handle, as one
 * kept in the process is, leaves it out.
 *
 * @public
 */
export interface JournalStorageSubject {
  readonly open: Effect.Effect<JournalStorageShape, never, Scope.Scope>
  readonly pair?: Effect.Effect<readonly [JournalStorageShape, JournalStorageShape], never, Scope.Scope>
}

const session = SessionId.make("kit-session")
const stranger = SessionId.make("kit-stranger")
const header: SessionHeader = { id: session, owner: Owner.make("kit-owner"), parent: SessionId.make("kit-parent"), createdAt: 1_767_225_600_000, format: JOURNAL_FORMAT }
/** A header as a check compares it: its fields, whatever order a store gives their keys in. */
const headerText = (one: SessionHeader): string => show([one.id, one.owner, one.parent ?? null, one.createdAt, one.format])
/** A header of another session, created at `createdAt`. */
const headerAt = (id: string, createdAt: number): SessionHeader => ({ ...header, id: SessionId.make(id), createdAt })
const turn = TurnNumber.make(1)
const next = TurnNumber.make(2)

/** The kit's own record, with a tag of its own. */
const noted = storedEvent("kit", "noted", { data: Schema.Json, skippable: true, tags: ["kit.noted"] })

/** An event whose envelope storage must give back as it got it. One key an object, so no store's key order shows. */
const draft = (text: string): StoredDraft => stored(noted, { note: { text, list: [1, "two", null] } }, { message: { _tag: "User", text } })

/** What storage adds to a draft is its place, its turn and its time; the rest is the draft's envelope. */
const draftOf = ({ seq: _seq, at: _at, turn: _turn, ...rest }: StoredEvent): Omit<StoredEvent, "seq" | "at" | "turn"> => rest

/** `call` must be refused for `reason`. */
const refused = (id: string, what: string, reason: JournalStorageError["reason"], call: Effect.Effect<unknown, JournalStorageError>) =>
  Effect.matchEffect(call, {
    onSuccess: () => fail(id, `${what} was accepted, not refused with ${reason}`),
    onFailure: (error) => expect(id, error.reason === reason, `${what} was refused with ${error.reason}, not ${reason}`),
  })

/**
 * The storage contract as checks, each over an empty store: a created
 * session reads back with its header (its id, owner, parent, creation time
 * and format, as given) and no events, and creating it again is refused and
 * changes nothing (`create`); an appended event comes back
 * stamped with the next place and its turn, and the events read back in order with
 * their envelopes as they were given (`append`); an append that expects
 * another place than the last stored one, behind it or ahead of it, is
 * refused and writes nothing (`conflict`); a read from a place gives the
 * events from there on, none past the end (`read-from`); a session never
 * created is missing to a read and to an append, beside one that reads
 * (`missing`); the header of every session is listed as it was given, by
 * creation time and then by id, and an empty store lists none (`list`).
 * For a subject with a `pair`: a second handle reads, lists and appends
 * after what the first wrote, and the first then meets the second's
 * append as a conflict (`reopens`).
 *
 * @public
 */
export const journalStorageConformance = (subject: JournalStorageSubject): ReadonlyArray<ConformanceCheck> => {
  /** One check over what `opened` gives. A `JournalStorageError` the check did not expect fails it. */
  const over = <S>(opened: Effect.Effect<S, never, Scope.Scope>) => (name: string, id: string, body: (storage: S) => Effect.Effect<void, ConformanceFailure | JournalStorageError>): ConformanceCheck => ({
    id,
    name,
    run: Effect.scoped(Effect.flatMap(opened, body)).pipe(
      Effect.catchTag("JournalStorageError", (error) => fail(id, `unexpected ${error.reason}: ${error.message}`)),
    ),
  })
  /** One check over a fresh store. */
  const check = over(subject.open)
  return [
    check("a created session reads back with its header, and is not created twice", "create", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      const created = yield* storage.read(session)
      yield* expect("create", created.header.id === session && created.header.owner === header.owner && created.events.length === 0,
        `a new session read back as ${show(created)}`)
      yield* expect("create", created.header.parent === header.parent && created.header.format === header.format && created.header.createdAt === header.createdAt,
        `a header with parent ${header.parent}, format ${header.format} and creation time ${header.createdAt} read back as ${show(created.header)}`)
      yield* storage.append(session, Seq.make(0), turn, draft("kept"))
      yield* refused("create", "creating a session a second time", "SessionExists", storage.create(header))
      const after = yield* storage.read(session)
      yield* expect("create", show(after.events.map(draftOf)) === show([draft("kept")]), `a refused create left the events as ${show(after.events)}`)
    })),
    check("an appended event is stamped with the next place, and the events read back in order as they were given", "append", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      const first = yield* storage.append(session, Seq.make(0), turn, draft("one"))
      const second = yield* storage.append(session, Seq.make(1), next, draft("two"))
      yield* expect("append", first.seq === 1 && second.seq === 2, `two appends were stamped ${first.seq} and ${second.seq}, not 1 and 2`)
      yield* expect("append", first.turn === turn && second.turn === next, `appends of turns ${turn} and ${next} were stamped turns ${first.turn} and ${second.turn}`)
      yield* expect("append", show(draftOf(second)) === show(draft("two")), `an appended event came back as ${show(second)}`)
      const stored = yield* storage.read(session)
      yield* expect("append", show(stored.events) === show([first, second]), `the appended events read back as ${show(stored.events)}, not ${show([first, second])}`)
    })),
    check("an append that expects another place than the last stored one writes nothing", "conflict", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      yield* storage.append(session, Seq.make(0), turn, draft("first"))
      yield* refused("conflict", "an append behind the journal", "SeqConflict", storage.append(session, Seq.make(0), turn, draft("late")))
      yield* refused("conflict", "an append ahead of the journal", "SeqConflict", storage.append(session, Seq.make(5), turn, draft("early")))
      const stored = yield* storage.read(session)
      yield* expect("conflict", show(stored.events.map(draftOf)) === show([draft("first")]), `the refused appends left the events as ${show(stored.events)}`)
    })),
    check("a read from a place gives the events from there on", "read-from", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      yield* storage.append(session, Seq.make(0), turn, draft("one"))
      yield* storage.append(session, Seq.make(1), turn, draft("two"))
      yield* storage.append(session, Seq.make(2), turn, draft("three"))
      const tail = yield* storage.read(session, Seq.make(2))
      yield* expect("read-from", tail.header.id === session && show(tail.events.map(draftOf)) === show([draft("two"), draft("three")]),
        `a read from 2 gave ${show(tail.events)}`)
      const past = yield* storage.read(session, Seq.make(4))
      yield* expect("read-from", past.events.length === 0, `a read past the end gave ${show(past.events)}`)
    })),
    check("a session never created is missing, beside one that reads", "missing", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      const created = yield* storage.read(session)
      yield* expect("missing", created.header.id === session, `the created session read back as ${show(created.header)}`)
      yield* refused("missing", "a read of a session never created", "SessionMissing", storage.read(stranger))
      yield* refused("missing", "an append to a session never created", "SessionMissing", storage.append(stranger, Seq.make(0), turn, draft("lost")))
    })),
    check("every session's header is listed as it was given, by creation time and then by id", "list", (storage) => Effect.gen(function* () {
      const none = yield* storage.list
      yield* expect("list", none.length === 0, `an empty store listed ${show(none)}`)
      // Created out of order, two of them in the same millisecond: the order is the headers', not the store's.
      const late = headerAt("kit-late", 30)
      const tiedB = headerAt("kit-tied-b", 10)
      const tiedA = headerAt("kit-tied-a", 10)
      const middle = headerAt("kit-middle", 20)
      yield* Effect.forEach([late, tiedB, tiedA, middle], (one) => storage.create(one), { concurrency: 1, discard: true })
      yield* storage.append(late.id, Seq.make(0), turn, draft("kept"))
      yield* refused("list", "creating a listed session a second time", "SessionExists", storage.create(tiedA))
      const listed = yield* storage.list
      yield* expect("list", show(listed.map(headerText)) === show([tiedA, tiedB, middle, late].map(headerText)),
        `four sessions created at 30, 10, 10 and 20 were listed as ${show(listed)}, not by creation time and then by id, each header as given`)
    })),
    ...(subject.pair === undefined ? [] : [
      over(subject.pair)("a second handle on the same medium reads, lists and appends after what the first wrote", "reopens", ([first, second]) => Effect.gen(function* () {
        yield* first.create(header)
        const one = yield* first.append(session, Seq.make(0), turn, draft("one"))
        const two = yield* first.append(session, Seq.make(1), turn, draft("two"))
        const reopened = yield* second.read(session)
        yield* expect("reopens", headerText(reopened.header) === headerText(header) && show(reopened.events) === show([one, two]),
          `a session written through one handle read back through another as ${show(reopened)}, not ${show({ header, events: [one, two] })}`)
        const listed = yield* second.list
        yield* expect("reopens", show(listed.map(headerText)) === show([headerText(header)]), `a session created through one handle was listed through another as ${show(listed)}`)
        yield* refused("reopens", "creating through the second handle a session the first created", "SessionExists", second.create(header))
        const three = yield* second.append(session, Seq.make(2), next, draft("three"))
        yield* expect("reopens", three.seq === 3, `an append through the second handle, after two through the first, was stamped ${three.seq}, not 3`)
        yield* refused("reopens", "an append through the first handle at the place the second has written at", "SeqConflict", first.append(session, Seq.make(2), next, draft("late")))
        const after = yield* first.read(session)
        yield* expect("reopens", show(after.events) === show([one, two, three]), `after both handles wrote, the first read ${show(after.events)}`)
      })),
    ]),
  ]
}
