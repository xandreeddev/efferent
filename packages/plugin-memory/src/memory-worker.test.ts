import { expect, test } from "bun:test"
import { EmbeddingModel } from "effect/ai"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Result } from "effect"
import { TestClock } from "effect/testing"
import {
  BackgroundWorkers, KnowledgeJobId, KnowledgeSourceId, LongTermMemory, makeKnowledgeIndexMemory,
  MemoryStore, UtilityCompletion, UtilityLlm,
} from "@xandreed/core"
import type { KnowledgeIndex, KnowledgeScope } from "@xandreed/core"
import { MemoryLive } from "./memory-engine.adapter.js"
import { memoryDefaults } from "./memory.entity.js"
import type { MemoryConfig } from "./memory.entity.js"

const scope: KnowledgeScope = { owner: "worker-owner", namespace: "worker-tests", collection: "memory" }
const text = "Alice prefers coffee"
const extraction = JSON.stringify({ entities: [], assertions: [], memories: [{ key: "coffee", kind: "preference", text, entities: [], spans: [{ start: 0, end: text.length, quote: text }], evidence: { _tag: "Stated" }, supersedes: [] }] })
const completion = new UtilityCompletion({ text: extraction, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })
const input = (id = "source") => ({ jobId: KnowledgeJobId.make(`${id}:1`), source: { scope, ref: { id: KnowledgeSourceId.make(id), revision: 1 }, text, occurredAt: 0, recordedAt: 0, metadata: {} }, engine: "fixture", expectedRevision: Option.none<number>() })
const embeddingResponse = (inputs: ReadonlyArray<string>) => ({ results: inputs.map(() => [1, 0]), usage: { inputTokens: inputs.length } })
const embeddings = (work: (inputs: ReadonlyArray<string>) => Effect.Effect<EmbeddingModel.ProviderResponse> = (inputs) => Effect.succeed(embeddingResponse(inputs))) => EmbeddingModel.make({ embedMany: ({ inputs }) => work(inputs) })
const open = Effect.fnUntraced(function* (index: KnowledgeIndex, utility: typeof UtilityLlm.Service, model: EmbeddingModel.EmbeddingModel, options: Partial<MemoryConfig> = {}) {
  const services = yield* Layer.build(MemoryLive({ ...memoryDefaults, namespace: scope.namespace, collection: scope.collection, embeddingDimensions: 2, worker: false, review: false, queryPlanning: false, rerank: false, modelTimeoutMs: 10_000, leaseMs: 30, ...options }).pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(MemoryStore, index), Layer.succeed(UtilityLlm, utility), Layer.succeed(EmbeddingModel.EmbeddingModel, model))),
  ))
  const worker = Context.get(services, BackgroundWorkers)[0]!
  return { memory: Context.get(services, LongTermMemory), worker }
})
const run = <A, E>(effect: Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(TestClock.layer())))

test("memory heartbeats retain leases throughout extraction, review and embedding", () => run(Effect.gen(function* () {
  const index = yield* makeKnowledgeIndexMemory()
  const extractionStarted = yield* Deferred.make<void>()
  const reviewStarted = yield* Deferred.make<void>()
  const embeddingStarted = yield* Deferred.make<void>()
  const allowExtraction = yield* Deferred.make<void>()
  const allowReview = yield* Deferred.make<void>()
  const allowEmbedding = yield* Deferred.make<void>()
  const calls = yield* Ref.make(0)
  const utility = UtilityLlm.of({ complete: () => Ref.getAndUpdate(calls, (n) => n + 1).pipe(Effect.flatMap((n) =>
    Deferred.succeed(n === 0 ? extractionStarted : reviewStarted, undefined).pipe(Effect.andThen(Deferred.await(n === 0 ? allowExtraction : allowReview)), Effect.as(completion)),
  )) })
  const model = yield* embeddings((inputs) => Deferred.succeed(embeddingStarted, undefined).pipe(Effect.andThen(Deferred.await(allowEmbedding)), Effect.as(embeddingResponse(inputs))))
  const { memory, worker } = yield* open(index, utility, model, { review: true })
  const job = yield* memory.capture(input())
  const processing = yield* Effect.forkChild(memory.process(scope, 1))
  yield* Deferred.await(extractionStarted)
  yield* TestClock.adjust(90)
  const first = yield* index.status(scope, job.id)
  expect(Option.isSome(first) && first.value.phase._tag === "Processing" && first.value.phase.leaseUntil).toBeGreaterThan(yield* Clock.currentTimeMillis)
  yield* Deferred.succeed(allowExtraction, undefined)
  yield* Deferred.await(reviewStarted)
  yield* TestClock.adjust(90)
  yield* Deferred.succeed(allowReview, undefined)
  yield* Deferred.await(embeddingStarted)
  yield* TestClock.adjust(90)
  expect(yield* worker.running).toBe(1)
  yield* Deferred.succeed(allowEmbedding, undefined)
  expect(yield* Fiber.join(processing)).toBe(1)
  expect(yield* worker.running).toBe(0)
  expect(Option.exists(yield* index.status(scope, job.id), (current) => current.phase._tag === "Complete")).toBe(true)
})))

test("memory stop waits for claim admission before reporting idle and admits no later jobs", () => run(Effect.gen(function* () {
  const index = yield* makeKnowledgeIndexMemory()
  const claimed = yield* Deferred.make<void>()
  const allowClaim = yield* Deferred.make<void>()
  const modelStarted = yield* Deferred.make<void>()
  const allowModel = yield* Deferred.make<void>()
  const wrapped: KnowledgeIndex = { ...index, claim: (request) => Deferred.succeed(claimed, undefined).pipe(Effect.andThen(Deferred.await(allowClaim)), Effect.andThen(index.claim(request))) }
  const utility = UtilityLlm.of({ complete: () => Deferred.succeed(modelStarted, undefined).pipe(Effect.andThen(Deferred.await(allowModel)), Effect.as(completion)) })
  const { memory, worker } = yield* open(wrapped, utility, yield* embeddings())
  yield* memory.capture(input())
  const processing = yield* Effect.forkChild(memory.process(scope, 1))
  yield* Deferred.await(claimed)
  const stopped = yield* Ref.make(false)
  const stopping = yield* Effect.forkChild(worker.stop.pipe(Effect.andThen(Ref.set(stopped, true))))
  yield* Effect.yieldNow
  expect(yield* Ref.get(stopped)).toBe(false)
  yield* Deferred.succeed(allowClaim, undefined)
  yield* Deferred.await(modelStarted)
  yield* Fiber.join(stopping)
  expect(yield* worker.running).toBe(1)
  yield* memory.capture(input("after-stop"))
  yield* Deferred.succeed(allowModel, undefined)
  expect(yield* Fiber.join(processing)).toBe(1)
  expect(yield* memory.process(scope, 1)).toBe(0)
  expect(Option.exists(yield* memory.status(scope, KnowledgeJobId.make("after-stop:1")), (job) => job.phase._tag === "Queued")).toBe(true)
})))

test("memory interruption requeues a staged manual job for a startup worker without re-extraction", () => run(Effect.gen(function* () {
  const index = yield* makeKnowledgeIndexMemory()
  const embeddingStarted = yield* Deferred.make<void>()
  const utility = UtilityLlm.of({ complete: () => Effect.succeed(completion) })
  const blocked = yield* embeddings(() => Deferred.succeed(embeddingStarted, undefined).pipe(Effect.andThen(Effect.never)))
  const first = yield* open(index, utility, blocked)
  const job = yield* first.memory.capture(input())
  const processing = yield* Effect.forkChild(first.memory.process(scope, 1))
  yield* Deferred.await(embeddingStarted)
  yield* first.worker.interrupt
  const cancelled = yield* Fiber.await(processing)
  expect(Exit.isFailure(cancelled) && Cause.hasInterrupts(cancelled.cause)).toBe(true)
  const pending = yield* index.status(scope, job.id)
  expect(Option.isSome(pending) && pending.value.phase._tag).toBe("Queued")
  expect(Option.isSome(pending) && Option.isSome(pending.value.stage)).toBe(true)
  expect(yield* first.worker.running).toBe(0)
  const resumed = yield* Deferred.make<void>()
  const calls = yield* Ref.make(0)
  const recovering = yield* embeddings((inputs) => Deferred.succeed(resumed, undefined).pipe(Effect.as(embeddingResponse(inputs))))
  const second = yield* open(index, UtilityLlm.of({ complete: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as(completion)) }), recovering, { worker: true, pollMs: 10 })
  yield* Deferred.await(resumed)
  yield* second.worker.stop
  yield* second.worker.idle
  expect(Option.exists(yield* second.memory.status(scope, job.id), (current) => current.phase._tag === "Complete")).toBe(true)
  expect(yield* Ref.get(calls)).toBe(0)
})))

test("memory defects become durable failures and retries count one active job", () => run(Effect.gen(function* () {
  const index = yield* makeKnowledgeIndexMemory()
  const extractionCalls = yield* Ref.make(0)
  const embeddingCalls = yield* Ref.make(0)
  const secondStarted = yield* Deferred.make<void>()
  const allowSecond = yield* Deferred.make<void>()
  const utility = UtilityLlm.of({ complete: () => Ref.update(extractionCalls, (n) => n + 1).pipe(Effect.as(completion)) })
  const model = yield* embeddings((inputs) => Ref.getAndUpdate(embeddingCalls, (n) => n + 1).pipe(Effect.flatMap((n) => n === 0
    ? Effect.die("synthetic embedding defect")
    : Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(allowSecond)), Effect.as(embeddingResponse(inputs))),
  )))
  const { memory, worker } = yield* open(index, utility, model)
  const job = yield* memory.capture(input())
  const processing = yield* Effect.forkChild(memory.process(scope, 1))
  yield* Deferred.await(secondStarted)
  expect(yield* worker.running).toBe(1)
  expect(yield* Ref.get(extractionCalls)).toBe(1)
  yield* Deferred.succeed(allowSecond, undefined)
  expect(yield* Fiber.join(processing)).toBe(1)
  expect(Option.exists(yield* memory.status(scope, job.id), (current) => current.phase._tag === "Complete" && current.attempt === 2)).toBe(true)
  expect(yield* worker.running).toBe(0)
})))

test("memory exhausted defects remain inspectable and manually retryable", () => run(Effect.gen(function* () {
  const index = yield* makeKnowledgeIndexMemory()
  const { memory, worker } = yield* open(index, UtilityLlm.of({ complete: () => Effect.die("synthetic extraction defect") }), yield* embeddings(), { maxAttempts: 2 })
  const job = yield* memory.capture(input())
  const result = yield* Effect.result(memory.process(scope, 1))
  expect(Result.isFailure(result) && result.failure.reason).toBe("Unavailable")
  const failed = yield* memory.status(scope, job.id)
  expect(Option.isSome(failed) && failed.value.phase._tag).toBe("Failed")
  expect(Option.isSome(failed) && failed.value.attempt).toBe(2)
  expect(yield* worker.running).toBe(0)
  expect((yield* memory.retry(scope, job.id)).phase._tag).toBe("Queued")
})))

test("memory CAS retry discards stale extraction after another graph publication", () => run(Effect.gen(function* () {
  const index = yield* makeKnowledgeIndexMemory()
  const injected = yield* Ref.make(false)
  const calls = yield* Ref.make(0)
  const wrapped: KnowledgeIndex = { ...index, publish: (lease) => Ref.getAndSet(injected, true).pipe(Effect.flatMap((already) => already
    ? index.publish(lease)
    : index.forget(scope, KnowledgeSourceId.make("unrelated"), lease.now).pipe(Effect.andThen(index.publish(lease))),
  )) }
  const utility = UtilityLlm.of({ complete: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as(completion)) })
  const { memory, worker } = yield* open(wrapped, utility, yield* embeddings())
  const job = yield* memory.capture(input())
  expect(yield* memory.process(scope, 1)).toBe(1)
  expect(yield* Ref.get(calls)).toBe(2)
  expect((yield* index.snapshot(scope)).version).toBe(2)
  expect(Option.exists(yield* memory.status(scope, job.id), (current) => current.phase._tag === "Complete" && current.attempt === 2)).toBe(true)
  expect(yield* worker.running).toBe(0)
})))

test("stalled memory planning and embeddings leave time for lexical evidence", () => run(Effect.gen(function* () {
  const index = yield* makeKnowledgeIndexMemory()
  const seeded = yield* open(index, UtilityLlm.of({ complete: () => Effect.succeed(completion) }), yield* embeddings())
  yield* seeded.memory.capture(input())
  yield* seeded.memory.process(scope, 1)
  const { memory } = yield* open(index, UtilityLlm.of({ complete: () => Effect.never }), yield* embeddings(() => Effect.never), { retrievalTimeoutMs: 100, queryPlanning: true })
  const query = yield* Effect.forkChild(Effect.result(memory.recall({ scope, query: "coffee", limit: 3, maxChars: 1000 })))
  yield* TestClock.adjust(100)
  const result = yield* Fiber.join(query)
  expect(Result.isSuccess(result) && result.success.candidates.length).toBe(1)
})))

test("a stalled memory store remains bounded by the complete retrieval deadline", () => run(Effect.gen(function* () {
  const index = yield* makeKnowledgeIndexMemory()
  const { memory } = yield* open({ ...index, search: () => Effect.never }, UtilityLlm.of({ complete: () => Effect.never }), yield* embeddings(), { retrievalTimeoutMs: 100, queryPlanning: false })
  const query = yield* Effect.forkChild(Effect.result(memory.recall({ scope, query: "coffee", limit: 3, maxChars: 1000 })))
  yield* TestClock.adjust(100)
  const result = yield* Fiber.join(query)
  expect(Result.isFailure(result) && result.failure.message).toBe("Memory retrieval exceeded its time budget")
})))
