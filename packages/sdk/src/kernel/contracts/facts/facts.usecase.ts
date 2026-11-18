import { Effect, Option, Result } from "effect"
import { currentFormat, Sessions } from "@xandreed/core/kernel"
import type { JournalStorageError, SessionHeader, SessionId, StoredEvent } from "@xandreed/core/kernel"
import { FACTS_OWNER } from "./facts.entity.js"

/**
 * The memory session among a store's headers: the first by creation that the plugin owns, that continues no
 * other, and that this kernel reads. One written in another journal format is passed over, as a host passes over
 * such a conversation: old journals are not migrated, and the facts start again in a new session.
 */
export const memoryAmong = (headers: ReadonlyArray<SessionHeader>): Option.Option<SessionId> =>
  Option.map(
    Option.fromNullishOr(headers.find((header) => header.owner === FACTS_OWNER && header.parent === undefined && Result.isSuccess(currentFormat(header)))),
    (header) => header.id,
  )

/**
 * The memory session's journal (ADR 0014), or none when there is no memory session: reading stores nothing, and no
 * session is created. What a reader of facts folds (`factsOf`, `learnedOf`), whichever plugin reads them.
 */
export const memoryJournal: Effect.Effect<ReadonlyArray<StoredEvent>, JournalStorageError, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  return yield* Option.match(memoryAmong(yield* sessions.list), {
    onNone: () => Effect.succeed<ReadonlyArray<StoredEvent>>([]),
    onSome: (id) => Effect.map(sessions.read(id), (journal) => journal.events),
  })
})
