import { Effect, Option, Schema } from "effect"
import type { Context } from "effect"
import { JournalCursor, MemorySnapshotData, SessionLogError } from "@xandreed/core"
import type { SessionDraft, SessionHeader, SessionLog, SessionLogEvent, SessionMissing } from "@xandreed/core"
import type { SessionsState } from "./sessions-state.entity.js"

type Log = Context.Service.Shape<typeof SessionLog>
const pointerSchema = Schema.Struct({ memorySnapshot: Schema.optionalKey(JournalCursor) })
const decodeData = Schema.decodeUnknownEffect(MemorySnapshotData)
const invalid = (cause: unknown) => new SessionLogError({ code: "session.decode", message: "The stored memory snapshot is invalid.", cause })

/** Authorized slices in lineage order; a sequence number never crosses a session boundary. */
const lineageOf = (log: Log, header: SessionHeader, through: number): Effect.Effect<ReadonlyArray<JournalCursor>, SessionMissing | SessionLogError> => Option.match(header.parent, {
  onNone: () => Effect.succeed([{ session: header.id, seq: through }]),
  onSome: (parent) => parent.through <= 0 ? Effect.succeed([{ session: header.id, seq: through }]) : log.head(parent.id).pipe(
    Effect.flatMap((head) => lineageOf(log, head.header, parent.through)),
    Effect.map((earlier) => [...earlier, { session: header.id, seq: through }]),
  ),
})

const validateFrontier = (data: MemorySnapshotData, lineage: ReadonlyArray<JournalCursor>) => {
  const position = (cursor: JournalCursor) => lineage.findIndex((slice) => slice.session === cursor.session && cursor.seq <= slice.seq)
  const anchor = position(data.anchor)
  const through = position(data.through)
  return anchor >= 0 && through >= anchor && (anchor !== through || data.anchor.seq <= data.through.seq)
    ? Effect.void : Effect.fail(invalid({ anchor: data.anchor, through: data.through, lineage }))
}

/** Derive the pointer from this CAS attempt's final stamped event positions. */
export const snapshotState = Effect.fnUntraced(function* (log: Log, header: SessionHeader, seq: number, state: SessionsState, drafts: ReadonlyArray<SessionDraft>) {
  const snapshots = drafts.flatMap((draft, offset) => draft.kind === "memory.snapshot" ? [{ draft, offset }] : [])
  if (snapshots.length === 0) return state
  const lineage = yield* lineageOf(log, header, seq)
  yield* Effect.forEach(snapshots, ({ draft }) => decodeData(draft.data).pipe(
    Effect.mapError(invalid), Effect.flatMap((data) => validateFrontier(data, lineage)),
  ), { concurrency: 1, discard: true })
  const last = snapshots.at(-1)!
  return { ...state, memorySnapshot: { session: header.id, seq: seq + last.offset + 1 } }
})

/** Read one eligible pointer; never fetch an ineligible future publication. */
export const readMemorySnapshot = Effect.fnUntraced(function* (log: Log, header: SessionHeader, started: SessionLogEvent, state: SessionsState): Effect.fn.Return<Option.Option<SessionLogEvent>, SessionMissing | SessionLogError> {
  const selected = (current: SessionHeader, ceiling: number, pointer: Option.Option<JournalCursor>): Effect.Effect<Option.Option<SessionLogEvent>, SessionMissing | SessionLogError> => Option.match(pointer, {
    onNone: () => Option.match(current.parent, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (parent) => parent.through <= 0 ? Effect.succeed(Option.none()) : log.head(parent.id).pipe(Effect.flatMap((head) =>
        Schema.decodeUnknownEffect(pointerSchema)(head.state.sessions ?? {}).pipe(
          Effect.mapError(invalid),
          Effect.flatMap((decoded) => selected(head.header, parent.through, Option.fromNullishOr(decoded.memorySnapshot))),
        ))),
    }),
    onSome: (cursor) => Effect.gen(function* () {
      if (cursor.session !== current.id) return yield* Effect.fail(invalid({ pointer: cursor, session: current.id }))
      if (cursor.seq > ceiling) return Option.none()
      const rows = yield* log.read(current.id, { after: cursor.seq - 1, through: cursor.seq, limit: Option.some(1), kinds: ["memory.snapshot"] })
      const row = rows[0]
      if (rows.length !== 1 || row === undefined || row.session !== current.id || row.seq !== cursor.seq || row.kind !== "memory.snapshot") {
        return yield* Effect.fail(invalid({ pointer: cursor, rows }))
      }
      const data = yield* decodeData(row.data).pipe(Effect.mapError(invalid))
      yield* validateFrontier(data, yield* lineageOf(log, current, row.seq - 1))
      return Option.some(row)
    }),
  })
  return yield* selected(header, started.seq - 1, Option.fromNullishOr(state.memorySnapshot))
})
