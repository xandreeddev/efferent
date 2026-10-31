import { Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { EntryId, LogEntry } from "./memory-log.entity.js"
// Keep inferred schema declarations inside core when a host also re-exports this class.
import type { UserMessage } from "../turn/user-message.entity.js"

/** The memory strategy whose retained render prefix a snapshot represents. @public */
export const MemoryStrategyId = Schema.String.pipe(Schema.brand("MemoryStrategyId"))
export type MemoryStrategyId = typeof MemoryStrategyId.Type

/** One actual event in an authorized lineage; sequence numbers are local to its session. @public */
export const JournalCursor = Schema.Struct({ session: ConversationId, seq: Schema.Int.check(Schema.isGreaterThan(0)) })
export type JournalCursor = typeof JournalCursor.Type

const Strategy = Schema.Struct({ id: MemoryStrategyId, version: Schema.String })

/** A durable render snapshot: raw retained facts preceding a real kept-turn anchor. @public */
export const MemorySnapshotData = Schema.Struct({
  version: Schema.Literal(1), strategy: Strategy, anchor: JournalCursor, through: JournalCursor, entries: Schema.Array(LogEntry),
})
export type MemorySnapshotData = typeof MemorySnapshotData.Type

/** A resolved snapshot intent; its anchor/frontier IDs must resolve to actual memory rows. @public */
export const MemorySnapshotCandidate = Schema.Struct({
  strategy: Strategy, anchor: EntryId, through: EntryId, entries: Schema.Array(LogEntry),
})
export type MemorySnapshotCandidate = typeof MemorySnapshotCandidate.Type

/** Runtime rule state; the full archive always remains authoritative. */
export const MemoryProjection = Schema.Union([
  Schema.TaggedStruct("Full", {}),
  Schema.TaggedStruct("Projected", {
    candidate: MemorySnapshotCandidate,
    cutTurn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    anchorIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    throughIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    checkedThrough: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type MemoryProjection = typeof MemoryProjection.Type
