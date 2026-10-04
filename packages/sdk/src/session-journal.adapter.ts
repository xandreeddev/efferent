import { Effect, Option, Ref, Stream } from "effect"
import { HarnessError } from "@xandreed/core"
import type { SessionAddress, SessionLogEvent, Sessions } from "@xandreed/core"

const failed = (error: { readonly _tag: string; readonly message?: string }) =>
  new HarnessError({ code: "session.log", message: error.message ?? error._tag })

/** Ancestors are read only up to each immutable fork boundary, retaining their source session identities. */
export const sessionJournalHistory = (
  sessions: Sessions["Service"], address: SessionAddress,
): Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError> => Effect.gen(function* () {
  const view = yield* sessions.get(address).pipe(Effect.mapError(failed))
  const inherited = yield* Option.match(view.header.parent, {
    onNone: () => Effect.succeed<ReadonlyArray<SessionLogEvent>>([]),
    onSome: (parent) => parent.through <= 0 ? Effect.succeed<ReadonlyArray<SessionLogEvent>>([])
      : sessionJournalHistory(sessions, { id: parent.id, owner: address.owner }).pipe(
        Effect.map((events) => events.filter((event) => event.session !== parent.id || event.seq <= parent.through))),
  })
  const own = yield* sessions.read(address).pipe(Effect.mapError(failed))
  return [...inherited, ...own]
})

/** Local commits wake immediately; periodic reads also observe another process's commits. */
export const followSessionJournal = (sessions: Sessions["Service"], address: SessionAddress, after?: number) =>
  Stream.unwrap(Effect.gen(function* () {
    const cursor = yield* Ref.make(after ?? 0)
    const first = yield* Ref.make(after === undefined)
    const wake = Stream.merge(sessions.changes(address), Stream.tick("1 second"))
    return Stream.concat(Stream.make(undefined), wake).pipe(
      Stream.mapEffect(() => Effect.gen(function* () {
        const initial = yield* Ref.getAndSet(first, false)
        const events = initial ? yield* sessionJournalHistory(sessions, address)
          : yield* sessions.read(address, { after: yield* Ref.get(cursor) }).pipe(Effect.mapError(failed))
        const own = events.filter((event) => event.session === address.id)
        if (own.length > 0) yield* Ref.set(cursor, own[own.length - 1]!.seq)
        return events
      })),
      Stream.flatMap(Stream.fromIterable),
    )
  }))
