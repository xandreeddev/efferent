import { Effect } from "effect"
import type { Context, Scope } from "effect"
import { expect, fail } from "./conformance.entity.functions.js"
import type { ConformanceCheck, ConformanceFailure } from "./conformance.entity.js"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import { EventName, Owner, Seq, SessionId } from "./ids.entity.js"
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
const header: SessionHeader = { id: session, owner: Owner.make("kit-owner"), format: JOURNAL_FORMAT }

/** An event whose envelope storage must give back as it got it. One key an object, so no store's key order shows. */
const draft = (text: string): StoredDraft => ({
  name: EventName.make("plugin.kit.noted"),
  data: { note: { text, list: [1, "two", null] } },
  skippable: true,
  message: { _tag: "User", text },
})

const show = (value: unknown): string => JSON.stringify(value)

/** What storage adds to a draft is its place and its time; the rest is the draft. */
const draftOf = ({ seq: _seq, at: _at, ...rest }: StoredEvent): StoredDraft => rest

/** `call` must be refused for `reason`. */
const refused = (id: string, what: string, reason: JournalStorageError["reason"], call: Effect.Effect<unknown, JournalStorageError>) =>
  Effect.matchEffect(call, {
    onSuccess: () => fail(id, `${what} was accepted, not refused with ${reason}`),
    onFailure: (error) => expect(id, error.reason === reason, `${what} was refused with ${error.reason}, not ${reason}`),
  })

/**
 * The storage contract as checks, each over an empty store: a created
 * session reads back with its header and no events, and creating it again
 * is refused and changes nothing (`create`); an appended event comes back
 * stamped with the next place, and the events read back in order with
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
      yield* storage.append(session, Seq.make(0), draft("kept"))
      yield* refused("create", "creating a session a second time", "SessionExists", storage.create(header))
      const after = yield* storage.read(session)
      yield* expect("create", show(after.events.map(draftOf)) === show([draft("kept")]), `a refused create left the events as ${show(after.events)}`)
    })),
    check("an appended event is stamped with the next place, and the events read back in order as they were given", "append", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      const first = yield* storage.append(session, Seq.make(0), draft("one"))
      const second = yield* storage.append(session, Seq.make(1), draft("two"))
      yield* expect("append", first.seq === 1 && second.seq === 2, `two appends were stamped ${first.seq} and ${second.seq}, not 1 and 2`)
      yield* expect("append", show(draftOf(second)) === show(draft("two")), `an appended event came back as ${show(second)}`)
      const stored = yield* storage.read(session)
      yield* expect("append", show(stored.events) === show([first, second]), `the appended events read back as ${show(stored.events)}, not ${show([first, second])}`)
    })),
    check("an append that expects another place than the last stored one writes nothing", "conflict", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      yield* storage.append(session, Seq.make(0), draft("first"))
      yield* refused("conflict", "an append behind the journal", "SeqConflict", storage.append(session, Seq.make(0), draft("late")))
      yield* refused("conflict", "an append ahead of the journal", "SeqConflict", storage.append(session, Seq.make(5), draft("early")))
      const stored = yield* storage.read(session)
      yield* expect("conflict", show(stored.events.map(draftOf)) === show([draft("first")]), `the refused appends left the events as ${show(stored.events)}`)
    })),
    check("a read from a place gives the events from there on", "read-from", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      yield* storage.append(session, Seq.make(0), draft("one"))
      yield* storage.append(session, Seq.make(1), draft("two"))
      yield* storage.append(session, Seq.make(2), draft("three"))
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
      yield* refused("missing", "an append to a session never created", "SessionMissing", storage.append(stranger, Seq.make(0), draft("lost")))
    })),
  ]
}
