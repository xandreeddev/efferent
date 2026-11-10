import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { memorySnapshotConformance, memorySnapshotFixture } from "./memory-snapshot.conformance.js"
import type { MemorySnapshotSubject } from "./memory-snapshot.conformance.js"
import { MemoryStrategyId } from "./memory-snapshot.entity.js"
import { RunId } from "../domain/run.entity.js"
import { prepareMemorySnapshot, projectMemorySnapshot, validateMemorySnapshot } from "./memory-snapshot.entity.functions.js"

const actual: MemorySnapshotSubject = { prepare: prepareMemorySnapshot, validate: validateMemorySnapshot, project: projectMemorySnapshot }
const failedChecks = (subject: MemorySnapshotSubject) => Effect.runPromise(Effect.forEach(memorySnapshotConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 },
).pipe(Effect.map((results) => results.flat())))

const careless: ReadonlyArray<{ readonly name: string; readonly check: string; readonly subject: MemorySnapshotSubject }> = [
  { name: "never selecting a snapshot", check: "selection", subject: { ...actual, prepare: () => Effect.succeed(Option.none()) } },
  { name: "swallowing selected corruption", check: "integrity", subject: { ...actual, validate: (...args) => validateMemorySnapshot(...args).pipe(Effect.catch(() => Effect.succeed({ _tag: "Full" as const }))) } },
  { name: "dropping the hidden assistant request", check: "selection", subject: { ...actual, prepare: (...args) => prepareMemorySnapshot(...args).pipe(Effect.map(Option.map((candidate) => ({ ...candidate, entries: candidate.entries.filter((entry) => entry.id !== "r1:3") })))) } },
  { name: "flattening result presentations", check: "selection", subject: { ...actual, prepare: (...args) => prepareMemorySnapshot(...args).pipe(Effect.map(Option.map((candidate) => ({ ...candidate, entries: candidate.entries.map((entry) => entry.id === "r1:6" && entry.body._tag === "ToolResult" ? { ...entry, body: { ...entry.body, pinned: true, view: "presented a" } } : entry) })))) } },
  { name: "projecting a cut run's step context", check: "options", subject: { ...actual, project: (entries, phase, options) => projectMemorySnapshot(entries, phase, { ...options, currentRun: RunId.make("r2") }) } },
  { name: "accepting retained facts unlike the archive's", check: "integrity", subject: { ...actual, validate: (entries, candidate, _strategy) => Effect.succeed({
    _tag: "Projected" as const, candidate, anchorIndex: Math.max(0, entries.findIndex((entry) => entry.id === candidate.anchor)), throughIndex: entries.findIndex((entry) => entry.id === candidate.through),
    cutTurn: 1, checkedThrough: entries.findIndex((entry) => entry.id === candidate.through), verified: [],
  }) } },
  { name: "never checking a placement's first render", check: "render-verify", subject: { ...actual, project: (entries, phase, options) => projectMemorySnapshot(entries, phase._tag === "Projected" ? { ...phase, verified: ["none", "tail"] } : phase, options) } },
  { name: "ignoring late dependencies", check: "fallback", subject: { ...actual, project: (entries, phase, options) => phase._tag === "Full" ? projectMemorySnapshot(entries, phase, options) : ({ phase, entries: [...phase.candidate.entries, ...entries.slice(phase.anchorIndex)], mismatch: false }) } },
  { name: "reusing another strategy", check: "compatibility", subject: { ...actual, project: (entries, phase, options) => projectMemorySnapshot(entries, phase, { ...options, strategy: "summary" }) } },
]

test.each([...memorySnapshotConformance()])("snapshot: $name", async (check) => { await Effect.runPromise(check.run) })

test.each([...careless])("the snapshot kit catches $name", async ({ subject, check }) => {
  expect(await failedChecks(subject)).toContain(check)
})

test("the default kit is deterministic and does not mutate its archive", async () => {
  const entries = memorySnapshotFixture()
  const before = JSON.stringify(entries)
  const found = await Effect.runPromise(prepareMemorySnapshot(entries, { id: MemoryStrategyId.make("summary"), version: "2" }))
  expect(Option.isSome(found)).toBe(true)
  expect(JSON.stringify(entries)).toBe(before)
  expect(Object.isFrozen(entries[0])).toBe(false)
  if (Option.isSome(found)) {
    expect(Object.isFrozen(found.value)).toBe(true)
    expect(Object.isFrozen(found.value.entries[0]?.body)).toBe(true)
  }
})
