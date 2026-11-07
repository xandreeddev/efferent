import { describe, expect, test } from "bun:test"
import { EmbeddingModel } from "effect/ai"
import { Deferred, Effect, Fiber, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Knowledge, KnowledgeEntityId, makeKnowledgeIndexMemory, RunContext, UtilityLlm } from "@xandreed/core"
import type { KnowledgeRecall, KnowledgeSearch, KnowledgeTraversal } from "@xandreed/core"
import { ragCapability } from "./rag-capability.adapter.js"
import { ragDefaults } from "./rag.entity.js"
import { enqueue, makeEmbeddings, makeRag, scope, scriptedUtility } from "./rag.testing.js"

const trackedGraphStore = Effect.gen(function* () {
  const index = yield* makeKnowledgeIndexMemory()
  const searches = yield* Ref.make<ReadonlyArray<KnowledgeSearch>>([])
  const traversals = yield* Ref.make<ReadonlyArray<KnowledgeTraversal>>([])
  const source = enqueue("atlas", "Atlas").source
  const store = {
    ...index,
    search: (query: KnowledgeSearch) => Ref.update(searches, (all) => [...all, query]).pipe(Effect.as({ lexical: [], semantic: [] })),
    snapshot: (ownScope: Parameters<typeof index.snapshot>[0]) => index.snapshot(ownScope).pipe(Effect.map((snapshot) => ({
      ...snapshot,
      graph: { entities: [{ id: KnowledgeEntityId.make("atlas"), name: "Atlas", type: "project", aliases: [], provenance: [{ source: source.ref, start: 0, end: 5, quote: "Atlas" }] }], assertions: [], truncated: false },
    }))),
    traverse: (query: KnowledgeTraversal) => Ref.update(traversals, (all) => [...all, query]).pipe(Effect.as({ entities: [], assertions: [], truncated: false })),
  }
  return { store, searches, traversals }
})

describe("document query controls", () => {
  test("explicit temporal coordinates independently override the plan and graph false disables traversal", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const tracked = yield* trackedGraphStore
    const reply = JSON.stringify({ queries: ["Atlas"], entities: ["Atlas"], validAt: 10, knownAt: 20 })
    const { utility } = yield* scriptedUtility([reply, reply, reply, reply])
    const { knowledge } = yield* makeRag({ queryPlanning: true }, tracked.store, undefined, utility)
    const input = { scope, query: "Atlas", limit: 2, maxChars: 1000 }
    yield* knowledge.retrieve({ ...input, graph: { perspective: { validAt: 100 }, depth: 2 } })
    yield* knowledge.retrieve({ ...input, graph: { perspective: { knownAt: 300 }, depth: 2 } })
    yield* knowledge.retrieve({ ...input, graph: { perspective: {}, depth: 2 } })
    yield* knowledge.retrieve({ ...input, graph: false })
    expect((yield* Ref.get(tracked.traversals)).map((query) => query.perspective)).toEqual([
      { validAt: 100, knownAt: 20 }, { validAt: 10, knownAt: 300 }, { validAt: 10, knownAt: 20 },
    ])
    expect((yield* Ref.get(tracked.searches)).map((query) => query.knownAt)).toEqual([Option.some(20), Option.some(300), Option.some(20), Option.some(20)])
  }))))

  test("missing temporal coordinates fall back to the retrieval clock", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* TestClock.setTime(1000)
    const tracked = yield* trackedGraphStore
    const { utility } = yield* scriptedUtility([JSON.stringify({ queries: ["Atlas"], entities: [], validAt: null, knownAt: 20 })])
    const { knowledge } = yield* makeRag({ queryPlanning: true }, tracked.store, undefined, utility)
    yield* knowledge.retrieve({ scope, query: "Atlas", limit: 2, maxChars: 1000, graph: { perspective: {}, depth: 2 } })
    expect((yield* Ref.get(tracked.traversals))[0]?.perspective).toEqual({ validAt: 1000, knownAt: 20 })
  })).pipe(Effect.provide(TestClock.layer()))))

  test("the tool preserves missing temporal coordinates and explicit graph opt-out", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const inputs = yield* Ref.make<ReadonlyArray<KnowledgeRecall>>([])
    const { knowledge } = yield* makeRag()
    const service = Knowledge.of({ ...knowledge, retrieve: (input) => Ref.update(inputs, (all) => [...all, input]).pipe(Effect.as({ candidates: [], graph: { entities: [], assertions: [], truncated: false }, history: [], sources: [] })) })
    const run = { session: { owner: scope.owner } } as typeof RunContext.Service
    const search = ragCapability({ ...ragDefaults, graph: true }).tools[0]!
    yield* search.handler({ query: "Atlas", knownAt: 42 }).pipe(Effect.provideService(Knowledge, service), Effect.provideService(RunContext, run))
    yield* search.handler({ query: "Atlas", graph: false }).pipe(Effect.provideService(Knowledge, service), Effect.provideService(RunContext, run))
    const requests = yield* Ref.get(inputs)
    expect(requests[0]?.graph).toEqual({ perspective: { knownAt: 42 }, depth: ragDefaults.graphDepth })
    expect(requests[1]?.graph).toBe(false)
    expect(requests[0]?.scope.owner).toBe(scope.owner)
  }))))

  test("a similarity floor keeps weakly similar passages out of semantic search, and none is set by default", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    // Neither passage shares a word with the question; the first is close to it, the second only weakly similar (cosine 0.3).
    const embeddings = yield* makeEmbeddings((text) => /harbour|ferry/i.test(text) ? [1, 0] : /orchard/i.test(text) ? [0.3, 0.954] : [0, 1])
    const search = Effect.fnUntraced(function* (options: Partial<typeof ragDefaults>) {
      const tracked = yield* trackedGraphStore
      const { knowledge } = yield* makeRag(options, undefined, embeddings)
      yield* knowledge.ingest(enqueue("harbour", "Harbour timetable notes."))
      yield* knowledge.ingest(enqueue("orchard", "Orchard harvest notes."))
      yield* knowledge.process(scope, 2)
      const found = yield* knowledge.retrieve({ scope, query: "When does a ferry leave?", limit: 4, maxChars: 1000, graph: false })
      // The same options against a recording store: what the engine asks of it.
      const { knowledge: recorded } = yield* makeRag(options, tracked.store, embeddings)
      yield* recorded.retrieve({ scope, query: "When does a ferry leave?", limit: 4, maxChars: 1000, graph: false })
      return { texts: found.candidates.map((candidate) => candidate._tag === "Chunk" ? candidate.chunk.text : candidate.memory.text), asked: (yield* Ref.get(tracked.searches)).map((query) => query.minSimilarity) }
    })
    expect(yield* search({})).toEqual({ texts: ["Harbour timetable notes.", "Orchard harvest notes."], asked: [undefined] })
    expect(yield* search({ minSimilarity: 0.5 })).toEqual({ texts: ["Harbour timetable notes."], asked: [0.5] })
  }))))

  test.each(["search", "traverse"] as const)("the total query deadline interrupts a stalled %s", (stalled) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const tracked = yield* trackedGraphStore
    const store = {
      ...tracked.store,
      search: (query: KnowledgeSearch) => stalled === "search" ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) : tracked.store.search(query),
      traverse: (query: KnowledgeTraversal) => stalled === "traverse" ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) : tracked.store.traverse(query),
    }
    const { knowledge } = yield* makeRag({ queryTimeoutMs: 100 }, store)
    const searching = yield* Effect.forkChild(Effect.result(knowledge.retrieve({ scope, query: "Atlas", limit: 2, maxChars: 1000, graph: { perspective: {}, depth: 2 } })))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(100)
    const result = yield* Fiber.join(searching)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.message).toBe("Document retrieval exceeded its time budget")
  })).pipe(Effect.provide(TestClock.layer()))))

  test("stalled planning and embedding retain time for lexical fallback", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stall = yield* Ref.make(false)
    const embeddings = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Ref.get(stall).pipe(Effect.flatMap((blocked) => blocked ? Effect.never : Effect.succeed({ results: inputs.map(() => [1, 0]), usage: { inputTokens: inputs.length } }))) })
    const utility = UtilityLlm.of({ complete: () => Effect.never })
    const { knowledge } = yield* makeRag({ queryPlanning: true, queryTimeoutMs: 100 }, undefined, embeddings, utility)
    yield* knowledge.ingest(enqueue("fallback", "stable evidence"))
    yield* knowledge.process(scope, 1)
    yield* Ref.set(stall, true)
    const searching = yield* Effect.forkChild(knowledge.retrieve({ scope, query: "stable", limit: 2, maxChars: 1000 }))
    yield* TestClock.adjust(50)
    expect((yield* Fiber.join(searching)).candidates).toHaveLength(1)
  })).pipe(Effect.provide(TestClock.layer()))))
})
