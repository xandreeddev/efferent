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
 * with its scope.
 *
 * @public
 */
export interface JournalStorageSubject {
  readonly open: Effect.Effect<JournalStorageShape, never, Scope.Scope>
}

const session = SessionId.make("kit-session")
const stranger = SessionId.make("kit-stranger")
const header: SessionHeader = { id: session, owner: Owner.make("kit-owner"), parent: SessionId.make("kit-parent"), format: JOURNAL_FORMAT }
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
 * session reads back with its header (its id, owner, parent and format, as
 * given) and no events, and creating it again is refused and changes
 * nothing (`create`); an appended event comes back
 * stamped with the next place and its turn, and the events read back in order with
 * their envelopes as they were given (`append`); an append that expects
 * another place than the last stored one, behind it or ahead of it, is
 * refused and writes nothing (`conflict`); a read from a place gives the
 * events from there on, none past the end (`read-from`); a session never
 * created is missing to a read and to an append, beside one that reads
 * (`missing`).
 *
 * @public
 */
export const journalStorageConformance = (subject: JournalStorageSubject): ReadonlyArray<ConformanceCheck> => {
  /** One check over a fresh store. A `JournalStorageError` the check did not expect fails it. */
  const check = (name: string, id: string, body: (storage: JournalStorageShape) => Effect.Effect<void, ConformanceFailure | JournalStorageError>): ConformanceCheck => ({
    id,
    name,
    run: Effect.scoped(Effect.flatMap(subject.open, body)).pipe(
      Effect.catchTag("JournalStorageError", (error) => fail(id, `unexpected ${error.reason}: ${error.message}`)),
    ),
  })
  return [
    check("a created session reads back with its header, and is not created twice", "create", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      const created = yield* storage.read(session)
      yield* expect("create", created.header.id === session && created.header.owner === header.owner && created.events.length === 0,
        `a new session read back as ${show(created)}`)
      yield* expect("create", created.header.parent === header.parent && created.header.format === header.format,
        `a header with parent ${header.parent} and format ${header.format} read back as ${show(created.header)}`)
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
  ]
}
