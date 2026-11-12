import { Effect, Option } from "effect"
import type { Context, Scope } from "effect"
import { expect, fail } from "./conformance.entity.functions.js"
import type { ConformanceCheck, ConformanceFailure } from "./conformance.entity.js"
import { EventName, Owner, Seq, SessionId } from "./ids.entity.js"
import type { StorageError, StoredEvent } from "./journal.entity.js"
import { JOURNAL_FORMAT } from "./session.entity.js"
import type { SessionHeader } from "./session.entity.js"
import type { Storage } from "./storage.port.js"

type StorageShape = Context.Service.Shape<typeof Storage>

/**
 * A storage backend as the kit opens it: an empty one per check, released
 * with its scope.
 *
 * @public
 */
export interface StorageSubject {
  readonly open: Effect.Effect<StorageShape, never, Scope.Scope>
}

const session = SessionId.make("kit-session")
const stranger = SessionId.make("kit-stranger")
const header: SessionHeader = { id: session, owner: Owner.make("kit-owner"), parent: Option.none(), format: JOURNAL_FORMAT }

/** An event whose data storage must give back as it got it. One key an object, so no store's key order shows. */
const event = (seq: number, text: string): StoredEvent => ({
  seq: Seq.make(seq),
  at: 1_767_225_600_000 + seq,
  name: EventName.make("plugin.kit.noted"),
  data: { note: { text, list: [seq, "two", null] } },
})

const show = (value: unknown): string => JSON.stringify(value)

/** `call` must be refused for `reason`. */
const refused = (id: string, what: string, reason: StorageError["reason"], call: Effect.Effect<unknown, StorageError>) =>
  Effect.matchEffect(call, {
    onSuccess: () => fail(id, `${what} was accepted, not refused with ${reason}`),
    onFailure: (error) => expect(id, error.reason === reason, `${what} was refused with ${error.reason}, not ${reason}`),
  })

/**
 * The storage contract as checks, each over an empty store: a created
 * session reads back with its header and no events, and creating it again
 * is refused and changes nothing (`create`); appended events read back in
 * order with their data as it was given (`append`); an append that expects
 * another place than the last stored one, behind it or ahead of it, is
 * refused and writes nothing (`conflict`); a read from a place gives the
 * events from there on, none past the end (`read-from`); a session never
 * created is missing to a read and to an append, beside one that reads
 * (`missing`).
 *
 * @public
 */
export const storageConformance = (subject: StorageSubject): ReadonlyArray<ConformanceCheck> => {
  /** One check over a fresh store. A `StorageError` the check did not expect fails it. */
  const check = (name: string, id: string, body: (storage: StorageShape) => Effect.Effect<void, ConformanceFailure | StorageError>): ConformanceCheck => ({
    name,
    run: Effect.scoped(Effect.flatMap(subject.open, body)).pipe(
      Effect.catchTag("StorageError", (error) => fail(id, `unexpected ${error.reason}: ${error.message}`)),
    ),
  })
  return [
    check("a created session reads back with its header, and is not created twice", "create", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      const created = yield* storage.read(session)
      yield* expect("create", created.header.id === session && created.header.owner === header.owner && Option.isNone(created.header.parent) && created.events.length === 0,
        `a new session read back as ${show(created)}`)
      yield* storage.append(session, Seq.make(0), [event(1, "kept")])
      yield* refused("create", "creating a session a second time", "SessionExists", storage.create(header))
      const after = yield* storage.read(session)
      yield* expect("create", show(after.events) === show([event(1, "kept")]), `a refused create left the events as ${show(after.events)}`)
    })),
    check("appended events read back in order, their data as it was given", "append", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      yield* storage.append(session, Seq.make(0), [event(1, "one"), event(2, "two")])
      yield* storage.append(session, Seq.make(2), [event(3, "three")])
      const stored = yield* storage.read(session)
      const expected = [event(1, "one"), event(2, "two"), event(3, "three")]
      yield* expect("append", show(stored.events) === show(expected), `the appended events read back as ${show(stored.events)}, not ${show(expected)}`)
    })),
    check("an append that expects another place than the last stored one writes nothing", "conflict", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      yield* storage.append(session, Seq.make(0), [event(1, "first")])
      yield* refused("conflict", "an append behind the journal", "SeqConflict", storage.append(session, Seq.make(0), [event(1, "late")]))
      yield* refused("conflict", "an append ahead of the journal", "SeqConflict", storage.append(session, Seq.make(5), [event(6, "early")]))
      const stored = yield* storage.read(session)
      yield* expect("conflict", show(stored.events) === show([event(1, "first")]), `the refused appends left the events as ${show(stored.events)}`)
    })),
    check("a read from a place gives the events from there on", "read-from", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      yield* storage.append(session, Seq.make(0), [event(1, "one"), event(2, "two"), event(3, "three")])
      const tail = yield* storage.read(session, Seq.make(2))
      yield* expect("read-from", tail.header.id === session && show(tail.events) === show([event(2, "two"), event(3, "three")]),
        `a read from 2 gave ${show(tail.events)}`)
      const past = yield* storage.read(session, Seq.make(4))
      yield* expect("read-from", past.events.length === 0, `a read past the end gave ${show(past.events)}`)
    })),
    check("a session never created is missing, beside one that reads", "missing", (storage) => Effect.gen(function* () {
      yield* storage.create(header)
      const created = yield* storage.read(session)
      yield* expect("missing", created.header.id === session, `the created session read back as ${show(created.header)}`)
      yield* refused("missing", "a read of a session never created", "SessionMissing", storage.read(stranger))
      yield* refused("missing", "an append to a session never created", "SessionMissing", storage.append(stranger, Seq.make(0), [event(1, "lost")]))
    })),
  ]
}
