import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Ref } from "effect"
import { InvocationId, RunId, RunOrdinal } from "../domain/run.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { makeToolResultReceipt } from "../domain/tool-result-receipt.entity.functions.js"
import { CurrentToolResultReceipt } from "../ports/tool-result-receipt.port.js"
import type { MemorySession, ToolViews } from "../ports/memory.port.js"
import { SessionLogError } from "../session/session-log.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { EntryId } from "./memory-log.entity.js"
import type { LogEntry } from "./memory-log.entity.js"
import { openLogSession } from "./memory-session.js"

const runId = RunId.make("receipt-run"), run = RunOrdinal.make(0), invocationId = InvocationId.make("receipt-run:call:1")
const target = () => ({ tool: "read", toolCallId: ToolCallId.make("same"), run: Option.some({ id: runId, turn: 1, ordinal: run }), step: 0 })
const initial: ReadonlyArray<LogEntry> = [{ id: EntryId.make("receipt-run:0"), runId, turn: 1, step: 0, at: 0, body: { _tag: "TurnStarted", userMessage: new UserMessage({ text: "read" }) } }]
const tail: ReadonlyArray<AgentMessage> = [{ role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("same"), toolName: "read", output: "answer", isError: false }] }]
const views: ToolViews = { view: () => Effect.succeed({ text: "answer", version: "raw", subjects: [], artifacts: [], pinned: false }), compact: () => Effect.succeed(Option.none()), digest: () => Effect.succeed(Option.none()) }
const policy = { strategy: { id: "test", version: "1" }, render: { turnContext: "current" as const, replies: true, digests: true, media: { mode: "none" as const, maxImages: 0, maxChars: 0 } }, digestOnWrite: Option.none(), maintain: () => Effect.succeed({ actions: [], digest: [] }) }
const ready = Effect.gen(function* () {
  const receipt = yield* makeToolResultReceipt(target())
  const owner = Option.getOrThrow(yield* receipt.offer.enter(target()))
  yield* owner.claim(invocationId)
  yield* owner.ready(Option.some({ invocationId, effectiveInput: { path: "rewritten" } }))
  return receipt
})

test("one raw ACK stores receipt metadata and marks Recorded before guarded view work", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* ready, stored = yield* Ref.make(initial), states = yield* Ref.make<ReadonlyArray<string>>([])
    const session = yield* openLogSession({ read: Ref.get(stored), append: (entries) => Effect.gen(function* () {
      const context = yield* CurrentToolResultReceipt
      const status = yield* receipt.guard.status
      yield* Ref.update(states, (all) => [...all, `append:${Option.isSome(context) ? context.value._tag : "None"}:${status}`])
      yield* Ref.update(stored, (all) => [...all, ...entries])
    }) }, policy, { runId })
    const ownViews: ToolViews = { ...views, view: () => Effect.gen(function* () {
      const context = yield* CurrentToolResultReceipt
      const status = yield* receipt.guard.status
      yield* Ref.update(states, (all) => [...all, `view:${Option.isSome(context) ? context.value._tag : "None"}:${status}`])
      return yield* views.view("read", "answer", {}, false)
    }) }
    yield* session.recordTail(tail, ownViews, 0, run).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))
    return { stored: yield* Ref.get(stored), states: yield* Ref.get(states), status: yield* receipt.guard.status }
  }))
  expect(result.states).toEqual(["append:Guard:Recording", "view:Guard:Recorded"])
  expect(result.stored.at(-1)?.body._tag === "ToolResult" && result.stored.at(-1)?.body).toMatchObject({ interception: { invocationId, effectiveInput: { path: "rewritten" } } })
  expect(result.status).toBe("Recorded")
})

test("matching raw-append reentry refuses before the already-held memory permit", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* ready, stored = yield* Ref.make(initial), seen = yield* Ref.make(false)
    const sessionReady = yield* Deferred.make<MemorySession>(), refusal = yield* Ref.make(false)
    const session = yield* openLogSession({ read: Ref.get(stored), append: (entries) => Effect.gen(function* () {
      if (!(yield* Ref.getAndSet(seen, true))) {
        const session = yield* Deferred.await(sessionReady)
        const nested = yield* session.recordTail(tail, views, 0, run).pipe(Effect.result, Effect.timeoutOption("100 millis"))
        yield* Ref.set(refusal, Option.isSome(nested) && nested.value._tag === "Failure")
      }
      yield* Ref.update(stored, (all) => [...all, ...entries])
    }) }, policy, { runId })
    yield* Deferred.succeed(sessionReady, session)
    yield* session.recordTail(tail, views, 0, run).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))
    return { refused: yield* Ref.get(refusal), stored: yield* Ref.get(stored) }
  }))
  expect(result.refused).toBe(true)
  expect(result.stored.filter((entry) => entry.body._tag === "ToolResult")).toHaveLength(1)
})

test("matching view reentry cannot append a second answer after the raw ACK", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* ready, stored = yield* Ref.make(initial), sessionReady = yield* Deferred.make<MemorySession>(), refused = yield* Ref.make(false)
    const session = yield* openLogSession({ read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }, policy, { runId })
    yield* Deferred.succeed(sessionReady, session)
    const ownViews: ToolViews = { ...views, view: () => Deferred.await(sessionReady).pipe(Effect.flatMap((session) => session.recordTail(tail, views, 0, run)), Effect.result,
      Effect.tap((result) => Ref.set(refused, result._tag === "Failure")), Effect.andThen(views.view("read", "answer", {}, false))) }
    yield* session.recordTail(tail, ownViews, 0, run).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))
    return { refused: yield* Ref.get(refused), stored: yield* Ref.get(stored) }
  }))
  expect(result.refused).toBe(true)
  expect(result.stored.filter((entry) => entry.body._tag === "ToolResult")).toHaveLength(1)
})

test("concurrent matching recorders reserve once before either takes the memory permit", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* ready, stored = yield* Ref.make(initial)
    const session = yield* openLogSession({ read: Ref.get(stored), append: (entries) => Effect.yieldNow.pipe(Effect.andThen(Ref.update(stored, (all) => [...all, ...entries]))) }, policy, { runId })
    const results = yield* Effect.all([session.recordTail(tail, views, 0, run).pipe(Effect.result), session.recordTail(tail, views, 0, run).pipe(Effect.result)], { concurrency: 2 }).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))
    return { results, stored: yield* Ref.get(stored) }
  }))
  expect(result.results.map((result) => result._tag).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)).toEqual(["Failure", "Success"])
  expect(result.stored.filter((entry) => entry.body._tag === "ToolResult")).toHaveLength(1)
})

test("lost raw ACK keeps its original error, closes the receipt and never re-appends", async () => {
  const original = new SessionLogError({ code: "store.io", message: "raw ACK was lost" })
  const result = await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* ready, stored = yield* Ref.make(initial), attempted = yield* Ref.make(false)
    const session = yield* openLogSession({ read: Ref.get(stored), snapshot: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]).pipe(Effect.andThen(Ref.getAndSet(attempted, true)), Effect.flatMap((earlier) => earlier ? Effect.void : Effect.fail(original))) }, policy, { runId })
    const first = yield* session.recordTail(tail, views, 0, run).pipe(Effect.result, Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))
    const second = yield* session.recordTail(tail, views, 0, run).pipe(Effect.result, Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))
    return { first, second, stored: yield* Ref.get(stored), status: yield* receipt.guard.status }
  }))
  expect(result.first._tag === "Failure" && result.first.failure).toBe(original)
  expect(result.second._tag).toBe("Failure")
  expect(result.status).toBe("Closed")
  expect(result.stored.filter((entry) => entry.body._tag === "ToolResult")).toHaveLength(1)
})

test("unrelated run and multipart results cannot borrow a matching call's metadata", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* ready, stored = yield* Ref.make(initial)
    const session = yield* openLogSession({ read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }, policy, { runId })
    yield* session.recordTail(tail, views, 0, RunOrdinal.make(1)).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))
    expect(yield* receipt.guard.status).toBe("Ready")
    const batch: ReadonlyArray<AgentMessage> = [{ role: "tool", content: [
      { type: "tool-result", toolCallId: ToolCallId.make("same"), toolName: "other", output: "answer" },
      { type: "tool-result", toolCallId: ToolCallId.make("same"), toolName: "read", output: "answer" },
    ] }]
    yield* session.recordTail(batch, views, 0, run).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))
    return (yield* Ref.get(stored)).flatMap((entry) => entry.body._tag === "ToolResult" ? [{ tool: entry.body.toolName, run: entry.body.run, interception: entry.body.interception }] : [])
  }))
  expect(result).toEqual([
    { tool: "read", run: RunOrdinal.make(1), interception: undefined }, { tool: "other", run: RunOrdinal.make(0), interception: undefined },
    { tool: "read", run: RunOrdinal.make(0), interception: { invocationId, effectiveInput: { path: "rewritten" } } },
  ])
})

test("duplicate matching parts and guard-only callbacks refuse without any append", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* ready, stored = yield* Ref.make(initial)
    const session = yield* openLogSession({ read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }, policy, { runId })
    const duplicate = yield* session.recordTail([...tail, ...tail], views, 0, run).pipe(Effect.result, Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))
    expect(duplicate._tag).toBe("Failure")
    const guarded = yield* session.recordTail(tail, views, 0, run).pipe(Effect.result, Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Guard", guard: receipt.guard })))
    expect(guarded._tag).toBe("Failure")
    expect(yield* Ref.get(stored)).toEqual(initial)
    expect(yield* receipt.guard.status).toBe("Ready")
  }))
})

test("interruption during a committed raw ACK closes recording while preserving the durable answer", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const receipt = yield* ready, stored = yield* Ref.make(initial), entered = yield* Deferred.make<void>(), release = yield* Deferred.make<void>()
    const session = yield* openLogSession({ read: Ref.get(stored), snapshot: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Deferred.await(release))) }, policy, { runId })
    const work = yield* session.recordTail(tail, views, 0, run).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })), Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(work)
    yield* Deferred.succeed(release, undefined)
    return { status: yield* receipt.guard.status, stored: yield* Ref.get(stored), cache: yield* session.entries }
  })))
  expect(result.status).toBe("Closed")
  expect(result.cache).toEqual(result.stored)
  expect(result.stored.at(-1)?.body._tag === "ToolResult" && result.stored.at(-1)?.body).toMatchObject({ interception: { invocationId, effectiveInput: { path: "rewritten" } } })
})

test("provider-executed flags cannot hide matching guard collisions or duplicate Record parts", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* ready, stored = yield* Ref.make(initial)
    const session = yield* openLogSession({ read: Ref.get(stored), append: (entries) => Ref.update(stored, (all) => [...all, ...entries]) }, policy, { runId })
    const fakeProvider: ReadonlyArray<AgentMessage> = [{ role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("same"), toolName: "read", output: "provider", providerExecuted: true }] }]
    const guarded = yield* session.recordTail(fakeProvider, views, 0, run).pipe(Effect.result, Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Guard", guard: receipt.guard })))
    expect(guarded._tag).toBe("Failure")
    const mixed = yield* session.recordTail([...fakeProvider, ...tail], views, 0, run).pipe(Effect.result, Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording })))
    expect(mixed._tag).toBe("Failure")
    expect(yield* Ref.get(stored)).toEqual(initial)
    const unrelated: ReadonlyArray<AgentMessage> = [{ role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("other-provider"), toolName: "provider", output: "answer", providerExecuted: true }] }]
    const saved = yield* session.recordTail(unrelated, views, 0, run).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Guard", guard: receipt.guard })))
    expect(saved[0]?.body._tag === "ToolResult" && saved[0].body.interception).toBeUndefined()
  }))
})
