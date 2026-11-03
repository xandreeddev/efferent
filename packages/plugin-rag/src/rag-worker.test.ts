import { describe, expect, test } from "bun:test"
import { EmbeddingModel } from "effect/ai"
import { Context, Deferred, Effect, Fiber, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { BackgroundWorkers, KnowledgeJobId, makeKnowledgeIndexMemory } from "@xandreed/core"
import { enqueue, makeRag, scope } from "./rag.testing.js"

describe("native document worker reliability", () => {
  test("leases are renewed throughout slow embedding", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const index = yield* makeKnowledgeIndexMemory()
    const renewed = yield* Ref.make(0)
    const store = { ...index, renew: (lease: Parameters<typeof index.renew>[0], duration: number) => Ref.update(renewed, (count) => count + 1).pipe(Effect.andThen(index.renew(lease, duration))) }
    const entered = yield* Deferred.make<void>()
    const embeddings = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.sleep(60)), Effect.as({ results: inputs.map(() => [1, 0]), usage: { inputTokens: 1 } })) })
    const { knowledge } = yield* makeRag({ leaseMs: 30, modelTimeoutMs: 100 }, store, embeddings)
    yield* knowledge.ingest(enqueue("slow", "Slow document evidence."))
    const processing = yield* Effect.forkChild(knowledge.process(scope, 1))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(60)
    expect(yield* Fiber.join(processing)).toBe(1)
    expect(yield* Ref.get(renewed)).toBeGreaterThanOrEqual(4)
    const job = yield* knowledge.status(scope, KnowledgeJobId.make("slow:1"))
    expect(Option.isSome(job) && job.value.phase._tag).toBe("Complete")
  })).pipe(Effect.provide(TestClock.layer()))))

  test("embedding defects are durable failures and do not leak active counts", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const embeddings = yield* EmbeddingModel.make({ embedMany: () => Effect.die("fixture embedding defect") })
    const { knowledge, built } = yield* makeRag({}, undefined, embeddings)
    yield* knowledge.ingest(enqueue("defect", "Staged evidence survives a defect."))
    expect((yield* Effect.result(knowledge.process(scope, 1)))._tag).toBe("Failure")
    const job = yield* knowledge.status(scope, KnowledgeJobId.make("defect:1"))
    expect(Option.isSome(job) && job.value.phase._tag).toBe("Failed")
    expect(Option.isSome(job) && Option.isSome(job.value.stage)).toBe(true)
    expect(yield* Context.get(built, BackgroundWorkers)[0]!.running).toBe(0)
  }))))

  test("worker interruption includes explicit process calls and returns staged work to the queue", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const index = yield* makeKnowledgeIndexMemory()
    const entered = yield* Deferred.make<void>()
    const embeddings = yield* EmbeddingModel.make({ embedMany: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) })
    const { knowledge, built } = yield* makeRag({}, index, embeddings)
    yield* knowledge.ingest(enqueue("manual", "A manually processed document."))
    const processing = yield* Effect.forkChild(knowledge.process(scope, 1))
    yield* Deferred.await(entered)
    const worker = Context.get(built, BackgroundWorkers)[0]!
    expect(yield* worker.running).toBe(1)
    yield* worker.interrupt
    expect((yield* Fiber.await(processing))._tag).toBe("Failure")
    expect(yield* worker.running).toBe(0)
    const queued = yield* knowledge.status(scope, KnowledgeJobId.make("manual:1"))
    expect(Option.isSome(queued) && queued.value.phase._tag).toBe("Queued")
    expect(Option.isSome(queued) && Option.isSome(queued.value.stage)).toBe(true)
    expect(yield* knowledge.process(scope, 1)).toBe(0)
    const resumed = yield* makeRag({}, index)
    expect(yield* resumed.knowledge.process(scope, 1)).toBe(1)
  }))))
})
