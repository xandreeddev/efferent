import { Array as Arr, Clock, Effect, Layer, Option, Schema } from "effect"
import { byCreation, JournalStorage, JournalStorageError, Seq, SessionHeader, StoredEvent } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"

/**
 * What `webStorageJournal` needs of a store of strings by key: the part of
 * a browser's `localStorage` it uses, as an interface of its own, so the
 * plugin names no browser type and runs wherever such a value exists (a
 * test hands it a `Map` behind these five members).
 *
 * @public
 */
export interface KeyValueStore {
  readonly length: number
  readonly key: (index: number) => string | null
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
  readonly removeItem: (key: string) => void
}

/**
 * How the web storage journal is set up.
 *
 * @public
 */
export interface WebStorageJournalOptions {
  /** What every key starts with: the store reads and writes no other key, so one storage holds several stores. */
  readonly prefix: string
}

const HEADER = "header"
const headerJson = Schema.fromJsonString(SessionHeader)
const eventJson = Schema.fromJsonString(StoredEvent)

const missing = (id: SessionId) => new JournalStorageError({ reason: "SessionMissing", message: `no session ${id}` })
const unreadable = (key: string) => new JournalStorageError({ reason: "Unreadable", message: `the value stored under ${key} is not a journal's: it was written by something else, or by another format` })

/**
 * Journals kept in a browser's `localStorage`, or in any value with its
 * five members: they outlive the page that wrote them. One key holds a
 * session's header (`<prefix><id>:header`) and one each of its events
 * (`<prefix><id>:<seq>`), as JSON, so an append writes one key and reads
 * two: the one at the place it expects, which must be there, and the one
 * after it, which must not. Every call reads and writes in one synchronous
 * step. The storage is shared by every page of an origin: the prefix keeps
 * a store's keys apart (a store whose prefix starts with another's is not
 * listed by it), and one writer at a time is the host's to arrange.
 * A storage that refuses a write (it is full, or blocked) is `Unavailable`;
 * a stored value that does not decode is `Unreadable`.
 *
 * @public
 */
export const webStorageJournal = (storage: KeyValueStore, options: WebStorageJournalOptions): Layer.Layer<JournalStorage> => {
  const headerKey = (id: SessionId) => `${options.prefix}${id}:${HEADER}`
  const eventKey = (id: SessionId, seq: number) => `${options.prefix}${id}:${seq}`
  /** One step against the storage: what it throws is the store being unavailable. */
  const step = <A>(run: () => A) => Effect.try({
    try: run,
    catch: (error) => new JournalStorageError({ reason: "Unavailable", message: `the storage refused: ${error instanceof Error ? error.message : "it gave no reason"}` }),
  })
  const decodeHeader = Schema.decodeUnknownEffect(headerJson)
  const decodeEvent = Schema.decodeUnknownEffect(eventJson)
  /** A stored value as what it should be; one that does not decode is not this store's to guess at. */
  const decoded = <A>(decode: (value: string) => Effect.Effect<A, unknown>, key: string, value: string) =>
    Effect.mapError(decode(value), () => unreadable(key))
  const header = (id: SessionId) => Effect.flatMap(step(() => Option.fromNullishOr(storage.getItem(headerKey(id)))), Option.match({
    onNone: () => Effect.fail(missing(id)),
    onSome: (value) => decoded(decodeHeader, headerKey(id), value),
  }))
  /** The stored events from a place on, read until the first key that is not there. */
  const eventsFrom = (id: SessionId, from: number) => Effect.flatMap(step(() => {
    const found: Array<readonly [string, string]> = []
    for (let seq = Math.max(1, from); ; seq++) {
      const value = storage.getItem(eventKey(id, seq))
      if (value === null) return found
      found.push([eventKey(id, seq), value])
    }
  }), (found) => Effect.forEach(found, ([key, value]) => decoded(decodeEvent, key, value), { concurrency: 1 }))

  return Layer.succeed(JournalStorage, JournalStorage.of({
    create: (created) => Effect.flatMap(Schema.encodeUnknownEffect(headerJson)(created).pipe(Effect.orDie), (value) => Effect.flatten(step(() => {
      if (storage.getItem(headerKey(created.id)) !== null) {
        return Effect.fail(new JournalStorageError({ reason: "SessionExists", message: `session ${created.id} exists` }))
      }
      storage.setItem(headerKey(created.id), value)
      return Effect.void
    }))),
    append: Effect.fnUntraced(function* (id, expectedSeq, turn, event) {
      const at = yield* Clock.currentTimeMillis
      const stored: StoredEvent = { seq: Seq.make(expectedSeq + 1), at, turn, ...event }
      const value = yield* Schema.encodeUnknownEffect(eventJson)(stored).pipe(Effect.orDie)
      return yield* Effect.flatten(step(() => {
        if (storage.getItem(headerKey(id)) === null) return Effect.fail(missing(id))
        const behind = expectedSeq > 0 && storage.getItem(eventKey(id, expectedSeq)) === null
        const ahead = storage.getItem(eventKey(id, expectedSeq + 1)) !== null
        if (behind || ahead) {
          return Effect.fail(new JournalStorageError({ reason: "SeqConflict", message: `the journal is not at ${expectedSeq}` }))
        }
        storage.setItem(eventKey(id, expectedSeq + 1), value)
        return Effect.succeed(stored)
      }))
    }),
    read: (id, from) => Effect.all({ header: header(id), events: eventsFrom(id, from ?? 1) }, { concurrency: 1 }),
    list: Effect.flatMap(step(() => {
      const found: Array<readonly [string, string]> = []
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        const value = key !== null && key.startsWith(options.prefix) && key.endsWith(`:${HEADER}`) ? storage.getItem(key) : null
        if (key !== null && value !== null) found.push([key, value])
      }
      return found
    }), (found) => Effect.map(
      // A key under the prefix that is another store's header (a store whose prefix starts with this one) is not this
      // store's session: only a header kept under its own id's key is listed.
      Effect.forEach(found, ([key, value]) => Effect.map(decoded(decodeHeader, key, value), (one) => key === headerKey(one.id) ? [one] : []), { concurrency: 1 }),
      (headers) => Arr.sort(headers.flat(), byCreation),
    )),
  }))
}
