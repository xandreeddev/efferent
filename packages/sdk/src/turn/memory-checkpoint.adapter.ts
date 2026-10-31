import { Effect, Exit, Option, Ref, Schema, Semaphore } from "effect"
import { canonicalJson, frameworkDraft, MEMORY_KINDS, MemorySnapshotCandidate, MemorySnapshotData, SessionLogError, storedJson } from "@xandreed/core"
import type { LogEntry, LogHandle, SessionLogEvent, TurnError, TurnWriter } from "@xandreed/core"
import { entryOfEvent, prepareMemorySnapshot } from "@xandreed/core/internal"

interface LocatedEntry { readonly event: SessionLogEvent; readonly entry: LogEntry }
const invalid = (message: string, cause?: unknown) => new SessionLogError({ code: "session.decode", message, ...(cause === undefined ? {} : { cause }) })
const locate = (events: ReadonlyArray<SessionLogEvent>) => Effect.forEach(events, (event) => entryOfEvent(event).pipe(
  Effect.map((entry) => Option.map(entry, (entry): LocatedEntry => ({ event, entry }))),
  Effect.mapError((cause) => invalid("snapshot source memory did not decode", cause)),
), { concurrency: 1 }).pipe(Effect.map((all) => all.flatMap(Option.toArray)))
const candidateJson = (candidate: MemorySnapshotCandidate) => Schema.encodeEffect(MemorySnapshotCandidate)(candidate).pipe(
  Effect.flatMap(storedJson), Effect.mapError((cause) => invalid("memory snapshot candidate did not encode", cause)),
)

/** The journal-aware bridge is initialized before a custom memory opener can call it. */
export const makeMemoryCheckpoint = Effect.fnUntraced(function* (
  writer: TurnWriter, history: Effect.Effect<ReadonlyArray<SessionLogEvent>, TurnError>,
): Effect.fn.Return<NonNullable<LogHandle["checkpoint"]>> {
  const gate = yield* Semaphore.make(1)
  const known = yield* Ref.make(Option.none<{ readonly entries: ReadonlyArray<LocatedEntry>; readonly cursor: number }>())
  const terminal = yield* Ref.make(Option.none<{ readonly key: string; readonly exit: Exit.Exit<void, TurnError> }>())
  const refresh = Effect.gen(function* () {
    const previous = yield* Option.match(yield* Ref.get(known), {
      onNone: () => history.pipe(Effect.flatMap(locate), Effect.map((entries) => ({ entries, cursor: writer.started.seq - 1 }))),
      onSome: Effect.succeed,
    })
    const own = (yield* writer.snapshot(MEMORY_KINDS, previous.cursor)).filter((event) => event.session === writer.started.session && event.seq > previous.cursor)
    const next = { entries: [...previous.entries, ...yield* locate(own)], cursor: own.reduce((last, event) => Math.max(last, event.seq), previous.cursor) }
    yield* Ref.set(known, Option.some(next))
    return next.entries
  })
  return {
    load: gate.withPermits(1)(Effect.gen(function* () {
      const selected = writer.memorySnapshot === undefined ? Option.none() : yield* writer.memorySnapshot
      if (Option.isNone(selected)) return Option.none<MemorySnapshotCandidate>()
      const row = selected.value
      if (row.kind !== "memory.snapshot") return yield* Effect.fail(invalid("selected memory snapshot has the wrong kind"))
      if (row.session === writer.started.session && row.seq >= writer.started.seq) return yield* Effect.fail(invalid("selected memory snapshot is outside this turn's history"))
      const data = yield* storedJson(row.data).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MemorySnapshotData)), Effect.mapError((cause) => invalid("selected memory snapshot did not decode", cause)))
      const all = yield* history.pipe(Effect.flatMap(locate))
      const publicationSession = all.findIndex(({ event }) => event.session === row.session)
      const before = (item: LocatedEntry, index: number) => item.event.session === row.session ? item.event.seq < row.seq : publicationSession >= 0 && index < publicationSession
      const anchor = all.findIndex(({ event }) => event.session === data.anchor.session && event.seq === data.anchor.seq)
      const through = all.findIndex(({ event }) => event.session === data.through.session && event.seq === data.through.seq)
      if (anchor < 0 || through < anchor || !before(all[anchor]!, anchor) || !before(all[through]!, through) || all[anchor]!.entry.body._tag !== "TurnStarted") {
        return yield* Effect.fail(invalid("selected memory snapshot cursors do not identify a visible kept turn and frontier"))
      }
      return Option.some({ strategy: data.strategy, anchor: all[anchor]!.entry.id, through: all[through]!.entry.id, entries: data.entries })
    })),
    save: Effect.fnUntraced(function* (input) {
      // Capture every opaque body before waiting for the serialization gate.
      const encoded = yield* candidateJson(input)
      const candidate = yield* Schema.decodeUnknownEffect(MemorySnapshotCandidate)(encoded).pipe(Effect.mapError((cause) => invalid("memory snapshot candidate did not decode", cause)))
      const key = canonicalJson(encoded)
      return yield* gate.withPermits(1)(Effect.uninterruptible(Effect.gen(function* () {
        const previous = yield* Ref.get(terminal)
        if (Option.isSome(previous) && previous.value.key === key) return yield* previous.value.exit
        const operation = Effect.gen(function* () {
          const actual = yield* refresh
          const anchor = actual.findIndex(({ entry }) => entry.id === candidate.anchor)
          const through = actual.findIndex(({ entry }) => entry.id === candidate.through)
          // Closing drafts have been accepted in memory, but have no durable row.
          if (anchor < 0 || through < 0) return
          if (through < anchor || actual[anchor]!.entry.body._tag !== "TurnStarted") return yield* Effect.fail(invalid("memory snapshot candidate has an invalid source frontier"))
          const expected = yield* prepareMemorySnapshot(actual.slice(0, through + 1).map(({ entry }) => entry), candidate.strategy)
          if (Option.isNone(expected) || canonicalJson(yield* candidateJson(expected.value)) !== key) return yield* Effect.fail(invalid("memory snapshot candidate differs from its durable source"))
          const data = yield* Schema.encodeEffect(MemorySnapshotData)({ version: 1, strategy: candidate.strategy,
            anchor: { session: actual[anchor]!.event.session, seq: actual[anchor]!.event.seq },
            through: { session: actual[through]!.event.session, seq: actual[through]!.event.seq }, entries: candidate.entries,
          }).pipe(Effect.flatMap(storedJson), Effect.mapError((cause) => invalid("memory snapshot did not encode", cause)))
          yield* writer.append([frameworkDraft("memory.snapshot", data)])
          yield* writer.flush
        })
        const exit = yield* operation.pipe(Effect.interruptible, Effect.exit)
        yield* Ref.set(terminal, Option.some({ key, exit }))
        return yield* exit
      })))
    }),
  }
})
