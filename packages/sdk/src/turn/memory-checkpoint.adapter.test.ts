import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import { ConversationId, ConversationMemory, draftsOfEntries, entryId, MemoryStrategyId, openLogSession, RunId, SessionLogError, storedJson, ToolRegistry, turnStartedDraft, UserMessage } from "@xandreed/core"
import type { LogBody, LogEntry, MemoryPolicy, SessionLogEvent, TurnWriter } from "@xandreed/core"
import { recordingTurnWriter } from "./testing.js"
import { TurnLive } from "./turn.adapter.js"
import { makeMemoryCheckpoint } from "./memory-checkpoint.adapter.js"

const conversation = ConversationId.make("00000000-0000-4000-8000-000000000023")
const oldRun = RunId.make("snapshot-old")
const runId = RunId.make("snapshot-new")
const at = (index: number, turn: number, body: LogBody): LogEntry => ({ id: entryId(oldRun, index), runId: oldRun, turn, step: 0, at: index, body })
const entries = [at(0, 1, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "old" }) }), at(1, 2, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "kept" }) }),
  at(2, 2, { _tag: "Compaction", strategy: "snapshot", version: "1", action: { _tag: "Summarize", keepFromTurn: 2, summary: "summary" } })]
const candidate = { strategy: { id: MemoryStrategyId.make("snapshot"), version: "1" }, anchor: entries[1]!.id, through: entries[2]!.id, entries: [] }
const data = { version: 1, strategy: candidate.strategy, anchor: { session: conversation, seq: 2 }, through: { session: conversation, seq: 3 }, entries: [] }
const policy: MemoryPolicy = { strategy: { id: "snapshot", version: "1" }, render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } }, digestOnWrite: Option.none(), maintain: () => Effect.succeed({ actions: [], digest: [] }) }
const rows = Effect.forEach(entries, (entry) => entry.body._tag === "TurnStarted"
  ? turnStartedDraft(entry.turn, { runId: entry.runId, entry: entry.id, key: entry.id, at: entry.at, origin: "user", userMessage: entry.body.userMessage, command: {}, claimed: [] })
  : draftsOfEntries([entry]).pipe(Effect.map((drafts) => drafts[0]!)), { concurrency: 1 }).pipe(Effect.map((drafts) => drafts.map((draft, index): SessionLogEvent => ({ session: conversation, seq: index + 1, at: 0, turn: draft.turn, kind: draft.kind, data: draft.data }))))
const registry = Layer.succeed(ToolRegistry, { catalog: { version: "1", recipes: [], tools: [] }, open: () => Effect.die("not used") })

test("SDK supplies a checkpoint load bridge with actual EntryIds during memory.open", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const selected: SessionLogEvent = { session: conversation, seq: 4, kind: "memory.snapshot", at: 0, turn: Option.none(), data: yield* storedJson(data) }
    const fixture = yield* recordingTurnWriter({ conversation, runId, turn: 3, text: "new", history: [...yield* rows, selected] })
    const captured = yield* Ref.make<unknown>(undefined)
    const memory = Layer.succeed(ConversationMemory, { strategy: policy.strategy, open: ({ log, runId }) => Effect.gen(function* () {
      yield* Ref.set(captured, log.checkpoint === undefined ? Option.none() : yield* log.checkpoint.load)
      return yield* openLogSession(log, policy, { runId })
    }) })
    yield* Layer.build(TurnLive({ turn: { ...fixture.writer, memorySnapshot: Effect.succeed(Option.some(selected)) } }).pipe(Layer.provide(Layer.merge(memory, registry))))
    return yield* Ref.get(captured)
  })))
  expect(result).toEqual(Option.some(candidate))
})

test("checkpoint save is initialized before custom memory.open invokes it", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* recordingTurnWriter({ conversation, runId, turn: 3, text: "new", history: yield* rows })
    const memory = Layer.succeed(ConversationMemory, { strategy: policy.strategy, open: ({ log, runId }) => Effect.gen(function* () {
      if (log.checkpoint !== undefined) yield* log.checkpoint.save(candidate)
      return yield* openLogSession(log, policy, { runId })
    }) })
    yield* Layer.build(TurnLive({ turn: { ...fixture.writer, memorySnapshot: Effect.succeed(Option.none()) } }).pipe(Layer.provide(Layer.merge(memory, registry))))
    return (yield* Ref.get(fixture.stored)).filter((event) => event.kind === "memory.snapshot")
  })))
  expect(result).toHaveLength(1)
  expect(result[0]!.data).toEqual(data)
})

test("a selected snapshot with a missing actual frontier fails session.decode", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const selected: SessionLogEvent = { session: conversation, seq: 4, kind: "memory.snapshot", at: 0, turn: Option.none(), data: yield* storedJson({ ...data, through: { session: conversation, seq: 99 } }) }
    const fixture = yield* recordingTurnWriter({ conversation, runId, turn: 3, text: "new", history: [...yield* rows, selected] })
    const memory = Layer.succeed(ConversationMemory, { strategy: policy.strategy, open: ({ log, runId }) => Effect.gen(function* () {
      yield* log.read
      if (log.checkpoint !== undefined) yield* log.checkpoint.load
      return yield* openLogSession(log, policy, { runId })
    }) })
    return yield* Layer.build(TurnLive({ turn: { ...fixture.writer, memorySnapshot: Effect.succeed(Option.some(selected)) } }).pipe(Layer.provide(Layer.merge(memory, registry)))).pipe(Effect.result)
  })))
  expect(result._tag === "Failure" && result.failure._tag === "SessionLogError" && result.failure.code).toBe("session.decode")
})

test("concurrent equal saves publish one protocol row and consume no memory IDs", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const history = yield* rows
    const fixture = yield* recordingTurnWriter({ conversation, runId, turn: 3, text: "new", history })
    const checkpoint = yield* makeMemoryCheckpoint(fixture.writer, Effect.succeed(history))
    yield* Effect.all([checkpoint.save(candidate), checkpoint.save(candidate), checkpoint.save(candidate)], { concurrency: 3 })
    return yield* Ref.get(fixture.stored)
  }))
  expect(result.filter((event) => event.kind === "memory.snapshot")).toHaveLength(1)
  expect(result.filter((event) => event.kind === "memory.snapshot")[0]!.data).toEqual(data)
  expect(result.filter((event) => event.kind === "turn.started").map((event) => event.data.entry)).toEqual([entries[0]!.id, entries[1]!.id, `${runId}:0`])
})

test("an accepted but nondurable closing frontier is skipped", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const history = yield* rows
    const fixture = yield* recordingTurnWriter({ conversation, runId, turn: 3, text: "new", history })
    const checkpoint = yield* makeMemoryCheckpoint(fixture.writer, Effect.succeed(history))
    yield* checkpoint.save({ ...candidate, through: entryId(runId, 90) })
    return yield* Ref.get(fixture.stored)
  }))
  expect(result.filter((event) => event.kind === "memory.snapshot")).toHaveLength(0)
})

test("a lost snapshot ACK retains its exact failure and does not append on repeated save", async () => {
  const original = new SessionLogError({ code: "store.io", message: "durable snapshot ACK was lost" })
  const result = await Effect.runPromise(Effect.gen(function* () {
    const history = yield* rows
    const fixture = yield* recordingTurnWriter({ conversation, runId, turn: 3, text: "new", history })
    const pending = yield* Ref.make(false)
    const writer: TurnWriter = { ...fixture.writer,
      append: (drafts) => fixture.writer.append(drafts).pipe(Effect.andThen(Ref.set(pending, drafts.some((draft) => draft.kind === "memory.snapshot")))),
      flush: Ref.get(pending).pipe(Effect.flatMap((pending) => pending ? Effect.fail(original) : fixture.writer.flush)),
    }
    const checkpoint = yield* makeMemoryCheckpoint(writer, Effect.succeed(history))
    return { first: yield* checkpoint.save(candidate).pipe(Effect.result), second: yield* checkpoint.save(candidate).pipe(Effect.result), events: yield* Ref.get(fixture.stored) }
  }))
  expect(result.first._tag === "Failure" && result.first.failure).toBe(original)
  expect(result.second._tag === "Failure" && result.second.failure).toBe(original)
  expect(result.events.filter((event) => event.kind === "memory.snapshot")).toHaveLength(1)
})

test("save snapshots caller data before a held protocol ACK", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const history = yield* rows
    const fixture = yield* recordingTurnWriter({ conversation, runId, turn: 3, text: "new", history })
    const pending = yield* Ref.make(false)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const writer: TurnWriter = { ...fixture.writer,
      append: (drafts) => fixture.writer.append(drafts).pipe(Effect.andThen(Ref.set(pending, true))),
      flush: Ref.get(pending).pipe(Effect.flatMap((pending) => pending ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)),
    }
    const checkpoint = yield* makeMemoryCheckpoint(writer, Effect.succeed(history))
    const input = { ...candidate, strategy: { ...candidate.strategy } }
    const saving = yield* checkpoint.save(input).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    input.strategy.version = "mutated"
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(saving)
    return yield* Ref.get(fixture.stored)
  })))
  expect(result.filter((event) => event.kind === "memory.snapshot")[0]!.data).toEqual(data)
})

test("interruption after publication is sticky without masking the writer wait", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const history = yield* rows
    const fixture = yield* recordingTurnWriter({ conversation, runId, turn: 3, text: "new", history })
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const published = yield* Ref.make(false)
    const checkpoint = yield* makeMemoryCheckpoint({ ...fixture.writer,
      append: (drafts) => fixture.writer.append(drafts).pipe(Effect.andThen(Ref.set(published, true))),
      flush: Ref.get(published).pipe(Effect.flatMap((published) => published ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)),
    }, Effect.succeed(history))
    const work = yield* checkpoint.save(candidate).pipe(Effect.uninterruptible, Effect.forkChild)
    yield* Deferred.await(entered)
    const interrupted = yield* Fiber.interrupt(work).pipe(Effect.timeoutOption("100 millis"))
    yield* Deferred.succeed(release, undefined)
    const first = yield* Fiber.await(work)
    const second = yield* checkpoint.save(candidate).pipe(Effect.exit)
    return { first, second, interrupted: Option.isSome(interrupted), stored: yield* Ref.get(fixture.stored) }
  })))
  expect(result.first._tag === "Failure" && Cause.hasInterrupts(result.first.cause)).toBe(true)
  expect(result.interrupted).toBe(true)
  expect(result.second._tag === "Failure" && Cause.hasInterrupts(result.second.cause)).toBe(true)
  expect(result.stored.filter((row) => row.kind === "memory.snapshot")).toHaveLength(1)
})

test("selected ancestor snapshot cursors resolve in lineage order with overlapping child seqs", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const parentRows = (yield* rows).map((row) => ({ ...row, seq: row.seq * 10 + 70 }))
    const child = ConversationId.make("00000000-0000-4000-8000-000000000024")
    const childStart = { ...parentRows[0]!, session: child, seq: 1 }
    const selected: SessionLogEvent = { session: conversation, seq: 110, kind: "memory.snapshot", at: 0, turn: Option.none(), data: yield* storedJson({ ...data, anchor: { session: conversation, seq: 90 }, through: { session: conversation, seq: 100 } }) }
    const fixture = yield* recordingTurnWriter({ conversation: child, runId, turn: 3, text: "new", history: [...parentRows, selected, childStart] })
    const checkpoint = yield* makeMemoryCheckpoint({ ...fixture.writer, memorySnapshot: Effect.succeed(Option.some(selected)) }, Effect.succeed([...parentRows, childStart]))
    return yield* checkpoint.load
  }))
  expect(result).toEqual(Option.some(candidate))
})
