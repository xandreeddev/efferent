import { describe, expect, test } from "bun:test"
import { EmbeddingModel } from "effect/ai"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Option, Ref, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { BackgroundWorkers, KnowledgeError, KnowledgeJobId, makeKnowledgeIndexMemory, shutdownGracefully } from "@xandreed/core"
import { enqueue, makeRag, scope } from "./rag.testing.js"

describe("native document worker reliability", () => {
  test("an idle document worker records no spans", () => {
    const names: Array<string> = []
    const tracer = Tracer.make({ span: (options) => {
      names.push(options.name)
      return new Tracer.NativeSpan(options)
    } })
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* makeRag({ worker: true, pollMs: 10 })
      yield* TestClock.adjust(100)
      expect(names.filter((name) => name.startsWith("knowledge_store."))).toEqual([])
    })).pipe(Effect.withTracer(tracer), Effect.provide(TestClock.layer())))
  })

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

  test("shutdown counts a stalled admitted claim and cancels it before embedding can start", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const index = yield* makeKnowledgeIndexMemory()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const embeddingCalls = yield* Ref.make(0)
    const store = { ...index, claim: (request: Parameters<typeof index.claim>[0]) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(index.claim(request))) }
    const embeddings = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Ref.update(embeddingCalls, (count) => count + 1).pipe(Effect.as({ results: inputs.map(() => [1, 0]), usage: { inputTokens: 1 } })) })
    const { knowledge, built } = yield* makeRag({}, store, embeddings)
    const job = yield* knowledge.ingest(enqueue("claim-deadline", "A document whose claim is stalled."))
    const worker = Context.get(built, BackgroundWorkers)[0]!
    const processing = yield* Effect.forkChild(knowledge.process(scope, 1))
    yield* Deferred.await(entered)
    expect(yield* worker.running).toBe(1)
    const shutdown = yield* Effect.forkChild(shutdownGracefully({ deadline: 20, reserve: 10 }).pipe(Effect.provideService(BackgroundWorkers, [worker])))
    yield* TestClock.adjust(20)
    expect(yield* Fiber.join(shutdown)).toMatchObject({ idle: false, left: { inFlight: true, runningWorkers: 1 } })
    yield* Deferred.succeed(release, undefined)
    const exit = yield* Fiber.await(processing)
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(yield* Ref.get(embeddingCalls)).toBe(0)
    expect(yield* worker.running).toBe(0)
    expect(Option.exists(yield* index.status(scope, job.id), (current) => current.phase._tag === "Queued")).toBe(true)
  })).pipe(Effect.provide(TestClock.layer()))))

  test("empty, failed and defective claims release admission activity", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const index = yield* makeKnowledgeIndexMemory()
    yield* Effect.forEach([Effect.succeed(Option.none()), Effect.fail(new KnowledgeError({ reason: "Unavailable", message: "Fixture claim failure" })), Effect.die("Fixture claim defect")], (claim) => Effect.gen(function* () {
      const { knowledge, built } = yield* makeRag({}, { ...index, claim: () => claim })
      const worker = Context.get(built, BackgroundWorkers)[0]!
      yield* Effect.exit(knowledge.process(scope, 1))
      expect(yield* worker.running).toBe(0)
      yield* worker.idle
    }), { concurrency: 1 })
  }))))
})
