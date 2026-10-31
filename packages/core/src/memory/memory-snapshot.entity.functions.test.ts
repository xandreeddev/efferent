import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import fc from "fast-check"
import { ToolCallId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { ArtifactId, EntryId, LogEntry, SubjectId } from "./memory-log.entity.js"
import type { LogBody } from "./memory-log.entity.js"
import { buildContext, canonicalJson, entriesSendingMedia } from "./memory-log.entity.functions.js"
import { memorySnapshotFixture, memorySnapshotOptions } from "./memory-snapshot.conformance.js"
import { prepareMemorySnapshot, projectMemorySnapshot, validateMemorySnapshot } from "./memory-snapshot.entity.functions.js"
import { MemorySnapshotCandidate, MemoryStrategyId } from "./memory-snapshot.entity.js"

const strategy = { id: MemoryStrategyId.make("summary"), version: "2" }
const options = memorySnapshotOptions()
const basic = options[0]!
const selected = async (entries: ReadonlyArray<LogEntry>) => {
  const candidate = await Effect.runPromise(prepareMemorySnapshot(entries, strategy))
  return Option.getOrThrow(candidate)
}
const same = (left: ReadonlyArray<LogEntry>, right: ReadonlyArray<LogEntry>, at = basic) => {
  expect(canonicalJson(buildContext(right, at))).toBe(canonicalJson(buildContext(left, at)))
  expect(entriesSendingMedia(right, at)).toEqual(entriesSendingMedia(left, at))
}
const row = (id: string, turn: number, step: number, body: LogBody): LogEntry => ({ id: EntryId.make(id), runId: RunId.make(`r${turn}`), at: 0, turn, step, body })

test("empty, uncut, anchorless and nonreducing histories do not prepare snapshots", async () => {
  const full = memorySnapshotFixture()
  const cases = [[], full.filter((entry) => entry.body._tag !== "Compaction"), full.filter((entry) => entry.body._tag !== "TurnStarted"), full.filter((entry) => entry.turn >= 2)]
  await Effect.runPromise(Effect.forEach(cases, (entries) => prepareMemorySnapshot(entries, strategy).pipe(
    Effect.tap((candidate) => Effect.sync(() => expect(Option.isNone(candidate)).toBe(true))),
  ), { concurrency: 1 }))
})

test("canonical encoded equality preserves Option wire values, signatures and opaque JSON", async () => {
  const full = memorySnapshotFixture().map((entry): LogEntry => entry.id === "r1:6" && entry.body._tag === "ToolResult" ? {
    ...entry, body: { ...entry.body, subjects: [{ kind: "file", id: SubjectId.make("path"), label: Option.some("label"), data: Option.some({ signed: "éΩ", extra: [false, null] }) }],
      artifacts: [{ id: ArtifactId.make("file"), kind: "file", mediaType: "text/plain", url: "https://example.test/file", alt: Option.none() }] },
  } : entry)
  const candidate = await selected(full)
  // Simulate a disk decoder rather than comparing runtime Option internals.
  const encoded = await Effect.runPromise(Schema.encodeEffect(MemorySnapshotCandidate)(candidate))
  const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(MemorySnapshotCandidate)(JSON.parse(JSON.stringify(encoded))))
  const phase = await Effect.runPromise(validateMemorySnapshot(full, decoded, strategy, basic))
  expect(phase._tag).toBe("Projected")
  same(full, projectMemorySnapshot(full, phase, basic).entries)
})

test("a compatible append keeps projection, a new old request dependency restores full history", async () => {
  const full = memorySnapshotFixture(), candidate = await selected(full)
  const phase = await Effect.runPromise(validateMemorySnapshot(full, candidate, strategy, basic))
  const ordinary = row("r2:later", 2, 2, { _tag: "Message", run: RunOrdinal.make(0), message: { role: "assistant", content: [{ type: "text", text: "later" }] } })
  const appended = [...full, ordinary]
  const projected = projectMemorySnapshot(appended, phase, basic)
  expect(projected.phase._tag).toBe("Projected")
  same(appended, projected.entries)
  // This is an actual old concurrent run completing after the newer turn.
  const late = row("r1:late-result", 1, 2, { _tag: "ToolResult", run: RunOrdinal.make(0), toolCallId: ToolCallId.make("late"), toolName: "lookup", isError: false,
    encoded: 7, view: "late", viewVersion: "1", subjects: [], artifacts: [], pinned: true })
  const withLate = [...appended, late]
  const restored = projectMemorySnapshot(withLate, projected.phase, basic)
  expect(restored.phase._tag).toBe("Full")
  same(withLate, restored.entries)
})

test("a shorter or replaced archive cannot reuse its previously checked offsets", async () => {
  const full = memorySnapshotFixture(), candidate = await selected(full)
  const phase = await Effect.runPromise(validateMemorySnapshot(full, candidate, strategy, basic))
  expect(projectMemorySnapshot(full.slice(0, -1), phase, basic).phase._tag).toBe("Full")
  expect(projectMemorySnapshot(full.map((entry) => entry.id === candidate.anchor ? { ...entry, id: EntryId.make("replacement") } : entry), phase, basic).phase._tag).toBe("Full")
})

const scenario = fc.record({
  pinX: fc.boolean(), pinB: fc.boolean(), oldReply: fc.string({ maxLength: 80 }), newReply: fc.string({ maxLength: 80 }),
  extra: fc.array(fc.record({ pinned: fc.boolean(), run: fc.integer({ min: 0, max: 2 }), value: fc.jsonValue(), missing: fc.boolean() }), { maxLength: 7 }),
  tail: fc.array(fc.string({ maxLength: 40 }), { maxLength: 4 }),
  option: fc.integer({ min: 0, max: options.length - 1 }),
})

test("generated interleaved raw journals preserve every build field and media choice", async () => {
  await fc.assert(fc.asyncProperty(scenario, async ({ pinX, pinB, oldReply, newReply, extra, tail, option }) => {
    const base = memorySnapshotFixture().map((entry): LogEntry => {
      if (entry.id === "r1:7" && entry.body._tag === "ToolResult") return { ...entry, body: { ...entry.body, pinned: pinX } }
      if (entry.id === "r1:5" && entry.body._tag === "ToolResult") return { ...entry, body: { ...entry.body, pinned: pinB } }
      if (entry.id === "r2:7" && entry.body._tag === "TurnEnded") return { ...entry, body: { ...entry.body, reply: Option.some(newReply) } }
      return entry
    })
    const extras = extra.flatMap((item, index): ReadonlyArray<LogEntry> => {
      const request = row(`r1:extra-request:${index}`, 1, index + 3, { _tag: "Message", run: RunOrdinal.make(item.run), message: { role: "assistant", content: [
        { type: "reasoning", text: oldReply, providerOptions: { signed: { signature: `sig-${index}-Ω` } } },
        { type: "tool-call", toolCallId: ToolCallId.make("reused"), toolName: "lookup", input: item.value },
      ] } })
      const result = row(`r1:extra-result:${index}`, 1, index + 3, { _tag: "ToolResult", run: RunOrdinal.make(item.run), toolCallId: ToolCallId.make("reused"), toolName: "lookup", isError: false,
        encoded: item.value, view: canonicalJson(item.value), viewVersion: "1", subjects: [], artifacts: [], pinned: item.pinned })
      return item.missing ? [request] : [request, result]
    })
    const full = [...base.filter((entry) => entry.turn < 2), ...extras, ...base.filter((entry) => entry.turn >= 2)]
    // Establish that generated logs pass the same stored schema as real archives.
    await Effect.runPromise(Schema.encodeEffect(Schema.Array(LogEntry))(full))
    const candidate = await selected(full)
    const at = options[option]!
    const phase = await Effect.runPromise(validateMemorySnapshot(full, candidate, strategy, at))
    expect(phase._tag).toBe("Projected")
    const projected = projectMemorySnapshot(full, phase, at)
    expect(projected.entries.length).toBeLessThan(full.length)
    same(full, projected.entries, at)
    const appended = [...full, ...tail.map((text, index) => row(`r2:tail:${index}`, 2, index + 2, { _tag: "StepContext", run: RunOrdinal.make(index % 2), step: index + 2, text }))]
    same(appended, projectMemorySnapshot(appended, phase, at).entries, at)
  }), { numRuns: 100, seed: 230023 })
})
