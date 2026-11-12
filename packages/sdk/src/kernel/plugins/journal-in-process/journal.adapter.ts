import { Clock, Effect, Layer, Ref } from "effect"
import { JournalStorage, JournalStorageError, Seq } from "@xandreed/core/kernel"
import type { Journal, SessionId, StoredEvent } from "@xandreed/core/kernel"

type Journals = ReadonlyMap<SessionId, Journal>
/** What a write decided: its answer, and the journals after it. */
type Decided<A> = readonly [Effect.Effect<A, JournalStorageError>, Journals]

const missing = (id: SessionId) => new JournalStorageError({ reason: "SessionMissing", message: `no session ${id}` })

/**
 * Journals kept in the process: the journals of one agent, gone with the
 * layer's scope. It keeps envelopes and knows nothing else. An append
 * copies the journal it adds to, so its cost grows with the journal: a
 * store for tests, lessons and short-lived agents.
 *
 * @public
 */
export const inProcessJournal = (): Layer.Layer<JournalStorage> => Layer.effect(JournalStorage, Effect.gen(function* () {
  const journals = yield* Ref.make<Journals>(new Map())
  return JournalStorage.of({
    create: (header) => Ref.modify(journals, (all): Decided<void> => all.has(header.id)
      ? [Effect.fail(new JournalStorageError({ reason: "SessionExists", message: `session ${header.id} exists` })), all]
      : [Effect.void, new Map([...all, [header.id, { header, events: [] }]])]).pipe(Effect.flatten),
    append: (id, expectedSeq, event) => Effect.flatMap(Clock.currentTimeMillis, (at) => Ref.modify(journals, (all): Decided<StoredEvent> => {
      const journal = all.get(id)
      if (journal === undefined) return [Effect.fail(missing(id)), all]
      if (journal.events.length !== expectedSeq) {
        return [Effect.fail(new JournalStorageError({ reason: "SeqConflict", message: `the journal is at ${journal.events.length}, not ${expectedSeq}` })), all]
      }
      const stored: StoredEvent = { seq: Seq.make(expectedSeq + 1), at, ...event }
      return [Effect.succeed(stored), new Map([...all, [id, { header: journal.header, events: [...journal.events, stored] }]])]
    })).pipe(Effect.flatten),
    read: (id, from) => Effect.flatMap(Ref.get(journals), (all) => {
      const journal = all.get(id)
      return journal === undefined ? Effect.fail(missing(id))
        : Effect.succeed(from === undefined ? journal : { header: journal.header, events: journal.events.filter((event) => event.seq >= from) })
    }),
  })
}))
