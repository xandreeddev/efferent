import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { readStored } from "../session/session-event.entity.functions.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import { JOURNAL_KINDS, MEMORY_KINDS, RESERVED_KINDS } from "../session/session-event.entity.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"
import { memorySnapshotFixture } from "./memory-snapshot.conformance.js"
import { JournalCursor, MemoryProjection, MemorySnapshotData, MemoryStrategyId } from "./memory-snapshot.entity.js"

const sessionIds = { parent: "00000000-0000-4000-8000-000000000001", child: "00000000-0000-4000-8000-000000000002", session: "00000000-0000-4000-8000-000000000003" }
const cursor = (session: keyof typeof sessionIds, seq: number) => ({ session: ConversationId.make(sessionIds[session]), seq })
const data: MemorySnapshotData = { version: 1, strategy: { id: MemoryStrategyId.make("summary"), version: "2" }, anchor: cursor("parent", 4), through: cursor("child", 2), entries: memorySnapshotFixture().slice(1, 3) }
const event = (value: SessionLogEvent["data"]): SessionLogEvent => ({ session: ConversationId.make(sessionIds.child), seq: 3, at: 0, turn: Option.some(2), kind: "memory.snapshot", data: value })

test("journal cursors name positive per-session sequences, including overlapping lineage sequences", async () => {
  expect(Schema.decodeUnknownOption(JournalCursor)(cursor("session", 1))).toEqual(Option.some(cursor("session", 1)))
  ;[0, -1, 0.5, Infinity, NaN].forEach((seq) => expect(Option.isNone(Schema.decodeUnknownOption(JournalCursor)(cursor("session", seq)))).toBe(true))
  const encoded = await Effect.runPromise(Schema.encodeEffect(MemorySnapshotData)(data))
  expect(await Effect.runPromise(Schema.decodeUnknownEffect(MemorySnapshotData)(encoded))).toEqual(data)
  expect(encoded.entries[0]?.body._tag).toBe("StepContext")
})

test("memory.snapshot is a reserved protocol record without a LogBody or memory EntryId", async () => {
  expect(JOURNAL_KINDS.includes("memory.snapshot")).toBe(true)
  expect(RESERVED_KINDS.includes("memory.snapshot")).toBe(true)
  expect(MEMORY_KINDS.some((kind) => String(kind) === "memory.snapshot")).toBe(false)
  const encoded = await Effect.runPromise(Schema.encodeEffect(MemorySnapshotData)(data).pipe(Effect.flatMap(storedJson)))
  const found = await Effect.runPromise(readStored("memory.snapshot", [event(encoded)]))
  expect(found.map((row) => row.data)).toEqual([data])
  const bad = await Effect.runPromise(Effect.result(readStored("memory.snapshot", [event({ ...encoded, version: 2 })])))
  expect(bad._tag).toBe("Failure")
  expect(await Effect.runPromise(readStored("memory.snapshot", [{ ...event({ version: 99 }), kind: "unrelated" }]))).toEqual([])
})

test("runtime projection carries one validated rule state and rejects invalid offsets", () => {
  expect(Option.isSome(Schema.decodeUnknownOption(MemoryProjection)({ _tag: "Full" }))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(MemoryProjection)({ _tag: "Projected", candidate: {}, cutTurn: -1, anchorIndex: 0, throughIndex: 0, checkedThrough: 0 }))).toBe(true)
})
