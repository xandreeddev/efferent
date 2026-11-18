import { Effect, Option, Result } from "effect"
import { currentFormat, Sessions } from "@xandreed/core/kernel"
import type { JournalStorageError, SessionHeader, SessionId, StoredEvent } from "@xandreed/core/kernel"
import { GRAPH_OWNER } from "./graph.entity.js"

/**
 * The graph session among a store's headers: the first by creation that the plugin owns, that continues no other,
 * and that this kernel reads, as the memory session of facts is found (ADR 0014).
 */
export const graphAmong = (headers: ReadonlyArray<SessionHeader>): Option.Option<SessionId> =>
  Option.map(
    Option.fromNullishOr(headers.find((header) => header.owner === GRAPH_OWNER && header.parent === undefined && Result.isSuccess(currentFormat(header)))),
    (header) => header.id,
  )

/**
 * The graph session's journal (ADR 0019), or none when there is no graph session: reading stores nothing, and no
 * session is created. What a reader of links folds (`linksOf`, `saidOf`), whichever plugin reads them.
 */
export const graphJournal: Effect.Effect<ReadonlyArray<StoredEvent>, JournalStorageError, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  return yield* Option.match(graphAmong(yield* sessions.list), {
    onNone: () => Effect.succeed<ReadonlyArray<StoredEvent>>([]),
    onSome: (id) => Effect.map(sessions.read(id), (journal) => journal.events),
  })
})
