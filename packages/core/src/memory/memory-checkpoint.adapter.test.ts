import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Ref } from "effect"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { SessionLogError } from "../session/session-log.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import { ResultDigester } from "../ports/memory.port.js"
import type { LogBody, LogEntry } from "./memory-log.entity.js"
import { entryId, buildContext, emptyQuery } from "./memory-log.entity.functions.js"
import { openLogSession } from "./memory-session.js"
import { MemoryStrategyId } from "./memory-snapshot.entity.js"
import { prepareMemorySnapshot } from "./memory-snapshot.entity.functions.js"
import type { MemoryPolicy } from "./memory-session.js"
import type { MemorySession, ToolViews } from "../ports/memory.port.js"
import type { TurnError } from "../session/sessions.entity.js"

const run = RunId.make("checkpoint-run")
const ordinal = RunOrdinal.make(0)
const at = (index: number, turn: number, body: LogBody): LogEntry => ({ id: entryId(run, index), runId: run, turn, step: 0, at: index, body })
const archive = [1, 2, 3].flatMap((turn) => [
  at((turn - 1) * 2, turn, { _tag: "TurnStarted", userMessage: new UserMessage({ text: `question ${turn} `.repeat(100) }) }),
  at((turn - 1) * 2 + 1, turn, { _tag: "TurnEnded", outcome: "completed", reply: Option.some(`answer ${turn} `.repeat(100)) }),
])
const summaryAction = { _tag: "Summarize" as const, keepFromTurn: 3, summary: "earlier conversation" }
const summary = at(6, 3, { _tag: "Compaction", strategy: "test", version: "1", action: summaryAction })
const compacted = [...archive, summary]
const policy = { strategy: { id: "test", version: "1" }, checkpoint: "render" as const,
  render: { turnContext: "current" as const, replies: true, digests: true, media: { mode: "none" as const, maxImages: 0, maxChars: 0 } },
  digestOnWrite: Option.none(), maintain: () => Effect.succeed({ actions: [], digest: [] }),
}
const views: ToolViews = { view: () => Effect.succeed({ text: "view", version: "1", pinned: false, subjects: [], artifacts: [] }), compact: () => Effect.succeed(Option.none()), digest: () => Effect.succeed(Option.none()) }
const options = { ...policy.render, stepContext: "none" as const, strategy: "test", currentTurn: 3, currentRun: run, run: ordinal }
const candidate = { strategy: { ...policy.strategy, id: MemoryStrategyId.make(policy.strategy.id) }, anchor: archive[4]!.id, through: summary.id, entries: [] }
const signal = { phase: "step" as const, lastUsage: Option.none(), budgetTokens: 1000, views }

test("an opted-in session loads a checkpoint once while archive readers and maintenance stay complete", async () => {
  const loads: number[] = []
  const maintained: number[] = []
  const observed = await Effect.runPromise(Effect.gen(function* () {
    const own = { ...policy, maintain: (input: Parameters<MemoryPolicy["maintain"]>[0]) => Effect.sync(() => { maintained.push(input.entries.length); return { actions: [], digest: [] } }) }
    const session = yield* openLogSession({ read: Effect.succeed(compacted), append: () => Effect.void, checkpoint: {
      load: Effect.sync(() => { loads.push(1); return Option.some(candidate) }), save: () => Effect.void,
    } }, own, { runId: run })
    const first = yield* session.build({ stepContext: "none", run: ordinal })
    yield* session.build({ stepContext: "tail", run: ordinal })
    yield* session.maintain(signal)
    return { first, entries: yield* session.entries, queried: yield* session.query(emptyQuery), transcript: yield* session.transcript("raw") }
  }))
  expect(loads).toHaveLength(1)
  expect(observed.first).toEqual(buildContext(compacted, options))
  expect(observed.entries).toEqual(compacted)
  expect(observed.queried).toEqual(compacted)
  expect(maintained).toEqual([compacted.length])
  expect(observed.transcript.length).toBe(3)
})

test("a reducing summary publishes its candidate only after the compaction append acknowledges", async () => {
  const saved: unknown[] = []
  const observed = await Effect.runPromise(Effect.gen(function* () {
    const stored = yield* Ref.make<ReadonlyArray<LogEntry>>(archive)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const session = yield* openLogSession({ read: Ref.get(stored), append: (entries) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Ref.update(stored, (all) => [...all, ...entries]))), checkpoint: {
      load: Effect.succeed(Option.none()), save: (candidate: unknown) => Effect.sync(() => { saved.push(candidate) }),
    } }, { ...policy, maintain: () => Effect.succeed({ actions: [summaryAction], digest: [] }) }, { runId: run })
    const work = yield* session.maintain(signal).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    expect(saved).toHaveLength(0)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(work)
    return yield* Ref.get(stored)
  }))
  expect(saved).toHaveLength(1)
  expect(observed.at(-1)?.body._tag).toBe("Compaction")
})

test("a malformed selected checkpoint fails with typed session.decode instead of silently ignoring it", async () => {
  const result = await Effect.runPromise(openLogSession({ read: Effect.succeed(compacted), append: () => Effect.void, checkpoint: {
    load: Effect.succeed(Option.some({ ...candidate, anchor: entryId(run, 999) })), save: () => Effect.void,
  } }, policy, { runId: run }).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure._tag === "SessionLogError" && result.failure.code).toBe("session.decode")
})

test("custom policies without the opt-in never call checkpoint capabilities", async () => {
  const calls: string[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const { checkpoint: _checkpoint, ...ordinary } = policy
    const session = yield* openLogSession({ read: Effect.succeed(archive), append: () => Effect.void, checkpoint: {
      load: Effect.sync(() => { calls.push("load"); return Option.some(candidate) }), save: () => Effect.sync(() => { calls.push("save") }),
    } }, { ...ordinary, maintain: () => Effect.succeed({ actions: [summaryAction], digest: [] }) }, { runId: run })
    yield* session.maintain(signal)
    yield* session.build({ stepContext: "none", run: ordinal })
  }))
  expect(calls).toEqual([])
})

test("a no-op or nonreducing summary publishes no snapshot", async () => {
  const saves: number[] = []
  await Effect.runPromise(Effect.forEach([[], [{ _tag: "Summarize" as const, keepFromTurn: 1, summary: "extra text" }]], (actions) => Effect.gen(function* () {
    const session = yield* openLogSession({ read: Effect.succeed(archive), append: () => Effect.void, checkpoint: {
      load: Effect.succeed(Option.none()), save: () => Effect.sync(() => { saves.push(1) }),
    } }, { ...policy, maintain: () => Effect.succeed({ actions, digest: [] }) }, { runId: run })
    yield* session.maintain(signal)
  }), { concurrency: 1 }))
  expect(saves).toEqual([])
})

test("snapshot save runs outside the memory allocation lock and preserves its older frontier", async () => {
  const facts: unknown[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const session: MemorySession = yield* openLogSession({ read: Effect.succeed(archive), append: () => Effect.void, checkpoint: {
      load: Effect.succeed(Option.none()), save: (candidate): Effect.Effect<void, TurnError> => Effect.sync(() => { facts.push(candidate) }).pipe(Effect.andThen(session.record([{ _tag: "Message", message: { role: "user", content: "arrived after summary" } }], 0)), Effect.asVoid),
    } }, { ...policy, maintain: () => Effect.succeed({ actions: [summaryAction], digest: [] }) }, { runId: run })
    yield* session.maintain(signal).pipe(Effect.timeout("1 second"))
    return yield* session.entries
  }))
  expect(facts).toHaveLength(1)
  expect(result.at(-1)?.body._tag).toBe("Message")
  expect(facts[0]).toMatchObject({ through: summary.id })
})

test("a checkpoint append failure retains its original typed error", async () => {
  const original = new SessionLogError({ code: "store.io", message: "checkpoint ACK unavailable" })
  const result = await Effect.runPromise(Effect.gen(function* () {
    const session = yield* openLogSession({ read: Effect.succeed(archive), append: () => Effect.void, checkpoint: {
      load: Effect.succeed(Option.none()), save: () => Effect.fail(original),
    } }, { ...policy, maintain: () => Effect.succeed({ actions: [summaryAction], digest: [] }) }, { runId: run })
    return yield* session.maintain(signal).pipe(Effect.result)
  }))
  expect(result._tag === "Failure" && result.failure).toBe(original)
})

test("build uses the loaded projection until an uncertain append restores the full archive", async () => {
  const touched: number[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "omitted answer ".repeat(100) }] }
    const old = at(1, 1, { _tag: "Message", message })
    const full = [archive[0]!, old, ...compacted.slice(2)]
    const prepared = Option.getOrThrow(yield* prepareMemorySnapshot(full, candidate.strategy))
    const durable = yield* Ref.make<ReadonlyArray<LogEntry>>(full)
    const original = new SessionLogError({ code: "store.io", message: "append committed, ACK lost" })
    const session = yield* openLogSession({ read: Ref.get(durable), snapshot: Ref.get(durable), append: (appended) => Ref.update(durable, (all) => [...all, ...appended]).pipe(Effect.andThen(Effect.fail(original))), checkpoint: {
      load: Effect.succeed(Option.some(prepared)), save: () => Effect.void,
    } }, policy, { runId: run })
    Object.defineProperty(old.body, "message", { configurable: true, get: () => { touched.push(1); return message } })
    const projected = yield* session.build({ stepContext: "none", run: ordinal })
    const projectionReads = touched.length
    buildContext(full, options)
    const controlReads = touched.length - projectionReads
    touched.length = 0
    const failed = yield* session.record([{ _tag: "Message", message: { role: "user", content: "new" } }], 0).pipe(Effect.result)
    yield* session.build({ stepContext: "none", run: ordinal })
    return { projected, projectionReads, controlReads, fallbackReads: touched.length, failed, original }
  }))
  expect(result.projectionReads).toBe(0)
  expect(result.controlReads).toBeGreaterThan(0)
  expect(result.fallbackReads).toBeGreaterThan(0)
  expect(result.failed._tag === "Failure" && result.failed.failure).toBe(result.original)
})

test("snapshot publication waits for requested digest acknowledgements too", async () => {
  const saved: number[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const result = at(7, 1, { _tag: "ToolResult", toolCallId: ToolCallId.make("old-result"), toolName: "lookup", isError: false, encoded: "raw", view: "large view ".repeat(100), viewVersion: "1", subjects: [], artifacts: [], pinned: false })
    const full = [...archive.slice(0, 2), result, ...archive.slice(2)]
    const stored = yield* Ref.make<ReadonlyArray<LogEntry>>(full)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const session = yield* openLogSession({ read: Ref.get(stored), append: (entries) => (entries.some((entry) => entry.body._tag === "ToolDigest")
      ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void).pipe(Effect.andThen(Ref.update(stored, (all) => [...all, ...entries]))), checkpoint: {
      load: Effect.succeed(Option.none()), save: () => Ref.get(stored).pipe(Effect.tap((entries) => Effect.sync(() => { expect(entries.at(-1)?.body._tag).toBe("ToolDigest"); saved.push(1) })), Effect.asVoid),
    } }, { ...policy, maintain: () => Effect.succeed({ actions: [summaryAction], digest: [result.id] }) }, { runId: run })
    const digestViews: ToolViews = { ...views, digest: () => Effect.succeed(Option.some({ tool: "lookup", version: "1", mode: "summarize", instructions: "summarize", userMessage: new UserMessage({ text: "question" }), items: [], source: "raw", preserve: [], apply: () => Option.some("short digest") })) }
    const work = yield* session.maintain({ ...signal, views: digestViews }).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    expect(saved).toHaveLength(0)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(work)
  }).pipe(Effect.provideService(ResultDigester, { id: "fixture", version: "1", digest: () => Effect.succeed({ keep: [], summary: Option.some("short digest") }) })))
  expect(saved).toHaveLength(1)
})
