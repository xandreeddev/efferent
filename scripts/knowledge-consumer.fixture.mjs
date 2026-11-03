/** Key-free native knowledge verification over installed public packages on Node and Bun. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Clock, Context, Effect, Layer, Option, Redacted, Ref } from "effect"
import { EmbeddingModel } from "effect/ai"
import {
  Knowledge, KnowledgeJobId, KnowledgeSourceId, KnowledgeStore, KnowledgeStoreMemoryLive,
  LongTermMemory, MemoryStore, MemoryStoreMemoryLive, TemporalGraph, TemporalGraphMemoryLive,
  UtilityCompletion, UtilityLlm,
} from "@xandreed/core"
import { knowledgeStoreConformance, memoryStoreConformance, temporalGraphConformance } from "@xandreed/core/conformance"
import { MemoryLive, memoryDefaults } from "@xandreed/plugin-memory"
import { RagLive, ragDefaults } from "@xandreed/plugin-rag"
import { makeKnowledgePostgres } from "@xandreed/plugin-knowledge-postgres"

const freshScope = (collection) => ({ owner: `packed-${randomUUID()}`, namespace: `packed-${randomUUID()}`, collection })
const memoryStorage = TemporalGraphMemoryLive.pipe(Layer.provideMerge(MemoryStoreMemoryLive))
const memorySubject = {
  open: Effect.gen(function* () {
    const services = yield* Layer.build(memoryStorage)
    return { index: Context.get(services, MemoryStore), graph: Context.get(services, TemporalGraph), scope: freshScope("memory") }
  }),
}
const knowledgeSubject = {
  open: Effect.gen(function* () {
    const services = yield* Layer.build(KnowledgeStoreMemoryLive)
    return { index: Context.get(services, KnowledgeStore), scope: freshScope("knowledge") }
  }),
}
const kit = (checks) => Effect.forEach(checks, (check) => check.run, { concurrency: 1, discard: true })
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const scripted = (protocol) => Effect.gen(function* () {
  const calls = yield* Ref.make(0)
  return {
    calls,
    utility: UtilityLlm.of({ complete: () => Ref.update(calls, (count) => count + 1).pipe(
      Effect.as(new UtilityCompletion({ text: JSON.stringify(protocol), usage })),
    ) }),
  }
})
const enqueue = (scope, id, text) => ({
  jobId: KnowledgeJobId.make(`${id}:1`),
  source: { scope, ref: { id: KnowledgeSourceId.make(id), revision: 1 }, text, occurredAt: 0, recordedAt: 0, metadata: { source: "packed-fixture" } },
  engine: "host", expectedRevision: Option.none(),
})
const verifySpan = (span, source) => {
  assert.deepEqual(span.source, source.ref)
  assert.equal(span.quote, source.text.slice(span.start, span.end))
}

const report = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const memoryChecks = memoryStoreConformance(memorySubject)
  const knowledgeChecks = knowledgeStoreConformance(knowledgeSubject)
  const graphChecks = temporalGraphConformance(memorySubject)
  yield* kit(memoryChecks)
  yield* kit(knowledgeChecks)
  yield* kit(graphChecks)

  const model = yield* EmbeddingModel.make({
    embedMany: ({ inputs }) => Effect.succeed({ results: inputs.map(() => [1, 0]), usage: { inputTokens: inputs.length } }),
  })
  const memoryScope = freshScope("memory")
  const memoryInput = enqueue(memoryScope, "personal-evidence", "Alice prefers coffee")
  const memoryProtocol = {
    entities: [{ key: "alice", name: "Alice", type: "person", aliases: [], existing: null, spans: [{ start: 0, end: 5, quote: "Alice" }] }],
    memories: [{ key: "coffee", kind: "preference", text: "Alice prefers coffee", entities: ["alice"], spans: [{ start: 0, end: 20, quote: memoryInput.source.text }], evidence: { _tag: "Stated" }, supersedes: [] }],
    assertions: [{ key: "prefers", subject: "alice", predicate: "prefers", object: { _tag: "Value", value: "coffee" }, text: "Alice prefers coffee", spans: [{ start: 0, end: 20, quote: memoryInput.source.text }], validFrom: 0, validTo: null, supersedes: [], supersession: "correction" }],
  }
  const helper = yield* scripted(memoryProtocol)
  const memoryContext = yield* Layer.build(MemoryLive({
    ...memoryDefaults, namespace: memoryScope.namespace, collection: memoryScope.collection,
    worker: false, embeddingModel: "packed-vectors", embeddingDimensions: 2,
    review: true, queryPlanning: false, rerank: false,
  }).pipe(Layer.provide(Layer.mergeAll(
    MemoryStoreMemoryLive,
    Layer.succeed(UtilityLlm, helper.utility),
    Layer.succeed(EmbeddingModel.EmbeddingModel, model),
  ))))
  const memory = Context.get(memoryContext, LongTermMemory)
  const job = yield* memory.capture(memoryInput)
  assert.equal((yield* memory.capture(memoryInput)).id, job.id)
  assert.equal(yield* memory.process(memoryScope, 1), 1)
  assert.equal(yield* Ref.get(helper.calls), 2)
  const recalled = yield* memory.recall({ scope: memoryScope, query: "Alice coffee", limit: 3, maxChars: 2000 })
  assert.equal(recalled.candidates.length, 1)
  assert.equal(recalled.candidates[0]._tag, "Memory")
  assert.equal(recalled.graph.assertions.length, 1)
  verifySpan(recalled.candidates[0].memory.provenance[0], memoryInput.source)
  verifySpan(recalled.graph.entities[0].provenance[0], memoryInput.source)
  verifySpan(recalled.graph.assertions[0].provenance[0], memoryInput.source)
  const memorySource = yield* memory.source(memoryScope, memoryInput.source.ref)
  assert.ok(Option.isSome(memorySource))
  assert.equal(memorySource.value.text, memoryInput.source.text)
  const isolated = yield* memory.recall({ scope: { ...memoryScope, owner: "another-owner" }, query: "coffee", limit: 3, maxChars: 1000 })
  assert.equal(isolated.candidates.length, 0)

  const documentScope = freshScope("knowledge")
  const documentInput = enqueue(documentScope, "deployment-guide", "Atlas deploys with the blue release lane.")
  const documentProtocol = {
    entities: [{ key: "atlas", name: "Atlas", type: "project", aliases: [], existing: null, spans: [{ start: 0, end: 5, quote: "Atlas" }] }],
    memories: [],
    assertions: [{ key: "deploys", subject: "atlas", predicate: "release_lane", object: { _tag: "Value", value: "blue" }, text: documentInput.source.text, spans: [{ start: 0, end: documentInput.source.text.length, quote: documentInput.source.text }], validFrom: 0, validTo: null, supersedes: [], supersession: "correction" }],
  }
  const documentHelper = yield* scripted(documentProtocol)
  const ragContext = yield* Layer.build(RagLive({
    ...ragDefaults, namespace: documentScope.namespace, collection: documentScope.collection,
    worker: false, embeddingModel: "packed-vectors", embeddingDimensions: 2,
    chunkChars: 200, overlapChars: 40, graph: true, review: true, queryPlanning: false, rerank: false,
  }).pipe(Layer.provide(Layer.mergeAll(
    KnowledgeStoreMemoryLive,
    Layer.succeed(UtilityLlm, documentHelper.utility),
    Layer.succeed(EmbeddingModel.EmbeddingModel, model),
  ))))
  const knowledge = Context.get(ragContext, Knowledge)
  yield* knowledge.ingest(documentInput)
  assert.equal(yield* knowledge.process(documentScope, 1), 1)
  assert.equal(yield* Ref.get(documentHelper.calls), 2)
  const retrieved = yield* knowledge.retrieve({
    scope: documentScope, query: "Atlas blue release", limit: 3, maxChars: 2000,
    graph: { perspective: { validAt: 1, knownAt: yield* Clock.currentTimeMillis }, depth: 2 },
  })
  assert.equal(retrieved.candidates.length, 1)
  assert.equal(retrieved.candidates[0]._tag, "Chunk")
  assert.equal(retrieved.graph.assertions.length, 1)
  verifySpan(retrieved.candidates[0].chunk.provenance, documentInput.source)
  verifySpan(retrieved.graph.assertions[0].provenance[0], documentInput.source)
  const documentSource = yield* knowledge.source(documentScope, documentInput.source.ref)
  assert.ok(Option.isSome(documentSource))
  assert.equal(documentSource.value.text, documentInput.source.text)

  const postgresUrl = process.env.EFFERENT_TEST_POSTGRES_URL
  if (postgresUrl) {
    const postgresMemory = { open: Effect.gen(function* () {
      const opened = yield* makeKnowledgePostgres(Redacted.make(postgresUrl))
      return { index: opened.memory, graph: opened.graph, scope: freshScope("memory") }
    }) }
    const postgresKnowledge = { open: Effect.gen(function* () {
      const opened = yield* makeKnowledgePostgres(Redacted.make(postgresUrl))
      return { index: opened.knowledge, scope: freshScope("knowledge") }
    }) }
    yield* kit(memoryStoreConformance(postgresMemory))
    yield* kit(knowledgeStoreConformance(postgresKnowledge))
    yield* kit(temporalGraphConformance(postgresMemory))
  }
  return {
    nativeMemory: true, nativeRag: true, sourceEvidence: true,
    referenceMemory: true, referenceKnowledge: true, temporalGraph: true,
    conformanceChecks: memoryChecks.length + knowledgeChecks.length + graphChecks.length,
    postgres: Boolean(postgresUrl),
  }
})))
process.stdout.write(`${JSON.stringify(report)}\n`)
