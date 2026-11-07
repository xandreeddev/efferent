import { describe, expect, test } from "bun:test"
import { Clock, Effect, Fiber, Option, Ref, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { CurrentKnowledgeHelperCall, KNOWLEDGE_EXTRACTION_VERSION, KnowledgeChunkId, KnowledgeError, KnowledgeJobId, KnowledgeMemoryId, KnowledgeSourceId, knowledgeEngineId, knowledgeExtractionWindows, makeKnowledgeIndexMemory, UtilityCompletion, UtilityLlm, zeroUsage } from "@xandreed/core"
import type { KnowledgeCandidate, KnowledgeHelperCall, KnowledgeJobFailure, KnowledgeMetadataFilter, KnowledgeSearch } from "@xandreed/core"
import { chunkDocument } from "./rag.entity.functions.js"
import { ragDefaults } from "./rag.entity.js"
import type { RagConfig } from "./rag.entity.js"
import { enqueue, makeEmbeddings, makeRag, scope, scriptedUtility } from "./rag.testing.js"

describe("native document ingestion", () => {
  test("chunks retain exact source spans, markdown boundaries and Unicode characters", () => {
    const source = enqueue("layout", `# First\n\n${"alpha 🙂 ".repeat(35)}\n\n## Second\n\n${"beta ".repeat(70)}\n\n\`\`\`ts\n${"const x = 1\n".repeat(20)}\`\`\``).source
    const chunks = chunkDocument(source, 200, 40)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every((chunk) => chunk.text === source.text.slice(chunk.provenance.start, chunk.provenance.end) && chunk.provenance.quote === chunk.text && chunk.text.length <= 200)).toBe(true)
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk.text) && !/^[\uDC00-\uDFFF]/u.test(chunk.text))).toBe(true)
    expect(chunks.some((chunk) => chunk.text.endsWith("\n\n"))).toBe(true)
    const positions = new Set(chunks.flatMap((chunk) => Array.from({ length: chunk.provenance.end - chunk.provenance.start }, (_, index) => index + chunk.provenance.start)))
    expect(positions.size).toBe(source.text.length)
    expect(chunkDocument(source, 200, 40).map((chunk) => chunk.id)).toEqual(chunks.map((chunk) => chunk.id))
  })

  test("plain RAG ingests and retrieves with citations without a utility model, with owner isolation", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { knowledge } = yield* makeRag()
    const source = enqueue("guide", "Atlas deploys through the blue release lane.")
    const job = yield* knowledge.ingest(source)
    expect((yield* knowledge.ingest(source)).id).toBe(job.id)
    expect(yield* knowledge.process(scope, 10)).toBe(1)
    const found = yield* knowledge.retrieve({ scope, query: "blue release", limit: 3, maxChars: 1000 })
    expect(found.candidates).toHaveLength(1)
    expect(found.candidates[0]?._tag).toBe("Chunk")
    if (found.candidates[0]?._tag === "Chunk") expect(found.candidates[0].chunk.provenance).toEqual({ source: source.source.ref, start: 0, end: 44, quote: source.source.text })
    expect(found.graph).toEqual({ entities: [], assertions: [], truncated: false })
    expect((yield* knowledge.retrieve({ scope: { ...scope, owner: "different" }, query: "blue", limit: 3, maxChars: 1000 })).candidates).toEqual([])
    expect(yield* knowledge.source({ ...scope, owner: "different" }, source.source.ref)).toEqual(Option.none())
    yield* knowledge.forget(scope, source.source.ref.id)
    expect((yield* knowledge.retrieve({ scope, query: "blue", limit: 3, maxChars: 1000 })).candidates).toEqual([])
    expect((yield* Effect.result(knowledge.ingest(source)))._tag).toBe("Failure")
  }))))

  test("two embedding configurations on one store each discover and process only the jobs of their own space", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { knowledge, store } = yield* makeRag()
    const { knowledge: otherSpace } = yield* makeRag({ embeddingModel: "other-embedder" }, store)
    const otherOwner = { ...scope, owner: "other-owner" }
    const job = yield* knowledge.ingest(enqueue("guide", "Atlas deploys through the blue release lane."))
    const manual = enqueue("manual", "Borealis deploys through the green release lane.")
    const otherJob = yield* otherSpace.ingest({ ...manual, source: { ...manual.source, scope: otherOwner } })
    expect(job.engine).toBe(knowledgeEngineId(`rag:${KNOWLEDGE_EXTRACTION_VERSION}`, { model: "host", version: "1", dimensions: 2 }))
    expect(otherJob.engine).toBe(knowledgeEngineId(`rag:${KNOWLEDGE_EXTRACTION_VERSION}`, { model: "other-embedder", version: "1", dimensions: 2 }))
    const discovered = (engine: string) => store.pending({ engine, namespace: scope.namespace, collection: scope.collection, now: 0, limit: 10 }).pipe(Effect.map((jobs) => jobs.map((entry) => entry.id)))
    expect(yield* discovered(job.engine)).toEqual([job.id])
    expect(yield* discovered(otherJob.engine)).toEqual([otherJob.id])
    expect(yield* otherSpace.process(scope, 10)).toBe(0)
    expect(Option.map(yield* store.status(scope, job.id), (current) => current.phase._tag)).toEqual(Option.some("Queued"))
    expect(yield* knowledge.process(otherOwner, 10)).toBe(0)
    expect(yield* knowledge.process(scope, 10)).toBe(1)
    expect(yield* otherSpace.process(otherOwner, 10)).toBe(1)
    expect(Option.map(yield* store.status(scope, job.id), (current) => current.phase._tag)).toEqual(Option.some("Complete"))
    expect(Option.map(yield* store.status(otherOwner, otherJob.id), (current) => current.phase._tag)).toEqual(Option.some("Complete"))
  }))))

  test("a failed replacement preserves the old published revision and resumes its staged chunks", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const failed = { value: false }
    const embeddings = yield* makeEmbeddings((text) => text.includes("new") && failed.value ? [1, 0, 0] : [1, 0])
    const { knowledge } = yield* makeRag({}, undefined, embeddings)
    yield* knowledge.ingest(enqueue("guide", "old stable evidence"))
    yield* knowledge.process(scope, 1)
    failed.value = true
    const next = yield* knowledge.ingest(enqueue("guide", "new replacement evidence", 2))
    expect((yield* Effect.result(knowledge.process(scope, 1)))._tag).toBe("Failure")
    const pending = yield* knowledge.status(scope, next.id)
    expect(Option.isSome(pending) && pending.value.phase._tag).toBe("Failed")
    expect(Option.isSome(pending) && Option.isSome(pending.value.stage)).toBe(true)
    const old = yield* knowledge.retrieve({ scope, query: "stable", limit: 3, maxChars: 1000 })
    expect(old.candidates[0]?._tag === "Chunk" && old.candidates[0].chunk.provenance.source.revision).toBe(1)
    failed.value = false
    yield* knowledge.retry(scope, next.id)
    yield* knowledge.process(scope, 1)
    const current = yield* knowledge.retrieve({ scope, query: "replacement", limit: 3, maxChars: 1000 })
    expect(current.candidates).toHaveLength(1)
    expect(current.candidates[0]?._tag === "Chunk" && current.candidates[0].chunk.provenance.source.revision).toBe(2)
    expect(Option.isSome(yield* knowledge.source(scope, { id: KnowledgeSourceId.make("guide"), revision: 1 }))).toBe(true)
  }))))

  test("a host retry requeues a job failed under the previous embedding version for the current engine, with its attempts reset", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeKnowledgeIndexMemory()
    const previous = yield* makeRag({}, store, yield* makeEmbeddings(() => [1, 0, 0]))
    const job = yield* previous.knowledge.ingest(enqueue("upgrade", "Evidence indexed again after an upgrade."))
    expect((yield* Effect.result(previous.knowledge.process(scope, 1)))._tag).toBe("Failure")
    const listed = yield* store.failed({ namespace: scope.namespace, collection: scope.collection, reasons: ["EmbeddingMismatch"], limit: 10 })
    expect(listed.jobs.map((failed) => [failed.id, failed.attempt])).toEqual([[job.id, 1]])
    const current = yield* makeRag({ embeddingVersion: "2" }, store)
    expect((yield* Effect.flip(current.knowledge.retry({ ...scope, collection: "elsewhere" }, job.id))).reason).toBe("Invalid")
    const requeued = yield* current.knowledge.retry(scope, job.id)
    expect({ engine: requeued.engine, attempt: requeued.attempt, staged: Option.isSome(requeued.stage) })
      .toEqual({ engine: knowledgeEngineId(`rag:${KNOWLEDGE_EXTRACTION_VERSION}`, { model: ragDefaults.embeddingModel, version: "2", dimensions: 2 }), attempt: 0, staged: false })
    expect(yield* previous.knowledge.process(scope, 1)).toBe(0)
    expect(yield* current.knowledge.process(scope, 1)).toBe(1)
    expect(Option.map(yield* current.knowledge.status(scope, job.id), (value) => [value.phase._tag, value.attempt])).toEqual(Option.some(["Complete", 1]))
    expect((yield* store.failed({ namespace: scope.namespace, limit: 10 })).jobs).toEqual([])
  }))))

  test("an interrupted job is resumed by a new scoped worker from its durable stage", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeKnowledgeIndexMemory()
    const bad = yield* makeEmbeddings(() => [1, 0, 0])
    const first = yield* makeRag({}, store, bad)
    yield* first.knowledge.ingest(enqueue("recover", "Recoverable document evidence."))
    yield* Effect.result(first.knowledge.process(scope, 1))
    yield* first.knowledge.retry(scope, KnowledgeJobId.make("recover:1"))
    const second = yield* makeRag({ worker: true, pollMs: 10 }, store)
    yield* TestClock.adjust("20 millis")
    const completed = yield* second.knowledge.status(scope, KnowledgeJobId.make("recover:1"))
    expect(Option.isSome(completed) && completed.value.phase._tag).toBe("Complete")
  })).pipe(Effect.provide(TestClock.layer()))))
})

const atlasGraph = { entities: [
  { key: "a", name: "Atlas", type: "project", aliases: [], existing: null, spans: [{ start: 0, end: 5, quote: "Atlas" }] },
  { key: "b", name: "Beacon", type: "service", aliases: [], existing: null, spans: [{ start: 11, end: 17, quote: "Beacon" }] },
], memories: [], assertions: [{ key: "owns", subject: "a", predicate: "owns", object: { _tag: "Entity", key: "b" }, text: "Atlas owns Beacon", spans: [{ start: 0, end: 18, quote: "Atlas owns Beacon." }], validFrom: 10, validTo: null, supersedes: [], supersession: "correction" }] }

describe("native temporal GraphRAG", () => {
  test("document graphs are opt-in and expand two hops beyond the retrieved chunk", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = { entities: [
      { key: "a", name: "Atlas", type: "project", aliases: [], existing: null, spans: [{ start: 0, end: 5, quote: "Atlas" }] },
      { key: "b", name: "Beacon", type: "service", aliases: [], existing: null, spans: [{ start: 11, end: 17, quote: "Beacon" }] },
    ], memories: [], assertions: [{ key: "owns", subject: "a", predicate: "owns", object: { _tag: "Entity", key: "b" }, text: "Atlas owns Beacon", spans: [{ start: 0, end: 18, quote: "Atlas owns Beacon." }], validFrom: 10, validTo: null, supersedes: [], supersession: "correction" }] }
    const second = { entities: [
      { key: "b", name: "Beacon", type: "service", aliases: [], existing: "one:1:entity:b", spans: [{ start: 0, end: 6, quote: "Beacon" }] },
      { key: "c", name: "Cedar", type: "team", aliases: [], existing: null, spans: [{ start: 14, end: 19, quote: "Cedar" }] },
    ], memories: [], assertions: [{ key: "serves", subject: "b", predicate: "serves", object: { _tag: "Entity", key: "c" }, text: "Beacon serves Cedar", spans: [{ start: 0, end: 20, quote: "Beacon serves Cedar." }], validFrom: 10, validTo: null, supersedes: [], supersession: "correction" }] }
    const { utility, prompts } = yield* scriptedUtility([JSON.stringify(first), JSON.stringify(second)])
    const embeddings = yield* makeEmbeddings((text) => text.includes("Cedar") ? [0, 1] : [1, 0])
    const { knowledge } = yield* makeRag({ graph: true, review: false }, undefined, embeddings, utility)
    yield* knowledge.ingest(enqueue("one", "Atlas owns Beacon.", 1, { team: "red" }))
    yield* knowledge.process(scope, 1)
    yield* knowledge.ingest(enqueue("two", "Beacon serves Cedar.", 1, { team: "blue" }))
    yield* knowledge.process(scope, 1)
    const perspective = { validAt: 20, knownAt: yield* Clock.currentTimeMillis }
    const plain = yield* knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000 })
    expect(plain.graph.assertions).toEqual([])
    expect(plain.candidates).toHaveLength(1)
    const one = yield* knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000, graph: { perspective, depth: 1 } })
    expect(one.graph.assertions.map((edge) => edge.predicate)).toEqual(["owns"])
    const two = yield* knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000, graph: { perspective, depth: 2 } })
    expect(two.graph.assertions.map((edge) => edge.predicate)).toEqual(["owns", "serves"])
    expect(two.graph.assertions[1]?.provenance[0]?.source.id).toBe(KnowledgeSourceId.make("two"))
    expect((yield* Ref.get(prompts))).toHaveLength(2)
    // A source filter narrows the graph too: no relation or entity span from an unlisted source.
    const onlyOne = yield* knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000, graph: { perspective, depth: 2 }, sources: [KnowledgeSourceId.make("one")] })
    expect(onlyOne.graph.assertions.map((edge) => edge.predicate)).toEqual(["owns"])
    expect(onlyOne.graph.entities.flatMap((entity) => entity.provenance.map((span) => String(span.source.id)))).toEqual(["one", "one"])
    expect(onlyOne.candidates.map((candidate) => candidate._tag === "Chunk" ? String(candidate.chunk.provenance.source.id) : "memory")).toEqual(["one"])
    const onlyTwo = yield* knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000, graph: { perspective, depth: 2 }, sources: [KnowledgeSourceId.make("two")] })
    expect([onlyTwo.candidates, onlyTwo.graph.assertions, onlyTwo.graph.entities]).toEqual([[], [], []])
    const listed = yield* knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000, graph: { perspective, depth: 2 }, sources: [KnowledgeSourceId.make("one"), KnowledgeSourceId.make("two")] })
    expect(listed).toEqual(two)
    expect((yield* Ref.get(prompts))).toHaveLength(2)
    // A metadata filter narrows candidates and the graph the same way, by the metadata of each cited revision, and composes with sources.
    const narrowed = (metadata: KnowledgeMetadataFilter, sources?: ReadonlyArray<string>) => knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000, graph: { perspective, depth: 2 }, metadata,
      ...(sources === undefined ? {} : { sources: sources.map((id) => KnowledgeSourceId.make(id)) }) })
    expect(yield* narrowed({ team: "red" })).toEqual(onlyOne)
    expect(yield* narrowed({ team: ["red", "blue"] })).toEqual(two)
    const blue = yield* narrowed({ team: "blue" })
    const redElsewhere = yield* narrowed({ team: "red" }, ["two"])
    expect([blue.candidates, blue.graph.assertions, blue.graph.entities, redElsewhere.candidates, redElsewhere.graph.entities]).toEqual([[], [], [], [], []])
    const before = yield* knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000, graph: { perspective: { ...perspective, validAt: 9 }, depth: 2 } })
    expect(before.graph.assertions).toEqual([])
  }))))

  test("a graph record that fails its own checks is dropped with a note while the chunks and the other records publish", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stray = { ...atlasGraph.assertions[0]!, key: "uses", predicate: "uses", object: { _tag: "Entity", key: "ledger" }, text: "Atlas uses Ledger" }
    const { utility } = yield* scriptedUtility([JSON.stringify({ ...atlasGraph, assertions: [...atlasGraph.assertions, stray] })])
    const { knowledge, store } = yield* makeRag({ graph: true, review: false }, undefined, undefined, utility)
    const job = yield* knowledge.ingest(enqueue("atlas", "Atlas owns Beacon."))
    expect(yield* knowledge.process(scope, 1)).toBe(1)
    const status = yield* knowledge.status(scope, job.id)
    expect(Option.map(status, (value) => [value.phase._tag, value.attempt])).toEqual(Option.some(["Complete", 1]))
    expect(Option.flatMap(status, (value) => value.stage).pipe(Option.map((stage) => [stage.chunks.length, stage.notes]))).toEqual(Option.some([1, [
      { _tag: "RecordDropped", record: "assertion", key: "uses", reason: "Invalid", message: "The extraction refers to an undefined entity key" },
    ]]))
    const graph = (yield* store.snapshot(scope)).graph
    expect([graph.entities.map((entity) => entity.name), graph.assertions.map((edge) => edge.predicate)]).toEqual([["Atlas", "Beacon"], ["owns"]])
    expect((yield* knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000 })).candidates).toHaveLength(1)
  }))))

  test("graph extraction requires a utility model, and personal memories from a document omit its graph", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const absent = yield* Effect.result(makeRag({ graph: true }))
    expect(absent._tag).toBe("Failure")
    const personal = JSON.stringify({ entities: [], memories: [{ key: "bad", kind: "preference", text: "User prefers this document", entities: [], spans: [{ start: 0, end: 5, quote: "Guide" }], evidence: { _tag: "Stated" }, supersedes: [], supersession: "change" }], assertions: [] })
    const { utility } = yield* scriptedUtility([personal])
    const { knowledge, store } = yield* makeRag({ graph: true, review: false }, undefined, undefined, utility)
    const job = yield* knowledge.ingest(enqueue("bad", "Guide data."))
    expect(yield* knowledge.process(scope, 1)).toBe(1)
    expect((yield* store.snapshot(scope)).memories).toEqual([])
    const status = yield* knowledge.status(scope, job.id)
    expect(Option.flatMap(status, (value) => value.stage).pipe(Option.map((stage) => stage.notes))).toEqual(Option.some([{ _tag: "GraphOmitted", reason: "Invalid", message: "Document extraction must not create personal memories" }]))
    // An earlier attempt records that refusal of the decoded extraction at stage `stage`.
    const { utility: twice } = yield* scriptedUtility([personal, personal])
    const failures = yield* Ref.make<ReadonlyArray<KnowledgeJobFailure>>([])
    const index = yield* makeKnowledgeIndexMemory()
    const recording = { ...index, fail: (lease: Parameters<typeof index.fail>[0], failure: KnowledgeJobFailure) => Ref.update(failures, (all) => [...all, failure]).pipe(Effect.andThen(index.fail(lease, failure))) }
    const retried = yield* makeRag({ graph: true, review: false, maxAttempts: 2 }, recording, undefined, twice)
    yield* retried.knowledge.ingest(enqueue("bad", "Guide data."))
    expect(yield* retried.knowledge.process(scope, 1)).toBe(1)
    expect(yield* Ref.get(failures)).toEqual([{ reason: "Invalid", message: "Document extraction must not create personal memories", step: "Graph", diagnostic: { stage: "stage" } }])
    expect((yield* knowledge.retrieve({ scope, query: "Guide", limit: 3, maxChars: 1000 })).candidates).toHaveLength(1)
  }))))

  test("an invalid graph answer is retried within maxAttempts, and the retry publishes the graph", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const index = yield* makeKnowledgeIndexMemory()
    const failures = yield* Ref.make<ReadonlyArray<KnowledgeJobFailure>>([])
    const recording = { ...index, fail: (lease: Parameters<typeof index.fail>[0], failure: KnowledgeJobFailure) => Ref.update(failures, (all) => [...all, failure]).pipe(Effect.andThen(index.fail(lease, failure))) }
    // The first answer is cut off at the output cap, inside its first relation.
    const whole = JSON.stringify(atlasGraph)
    const cut = new UtilityCompletion({ text: whole.slice(0, whole.indexOf("\"assertions\"") + 20), usage: { ...zeroUsage, outputTokens: 2048, totalTokens: 2048 }, finishReason: "length" })
    const { utility, prompts } = yield* scriptedUtility([cut, whole])
    const { knowledge, store } = yield* makeRag({ graph: true, review: false, maxAttempts: 2 }, recording, undefined, utility)
    const job = yield* knowledge.ingest(enqueue("one", "Atlas owns Beacon."))
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({ span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    } })
    expect(yield* knowledge.process(scope, 1).pipe(Effect.withTracer(tracer))).toBe(1)
    // The graph step's failure records where and how its extraction failed, and so does the span that processed it.
    expect(yield* Ref.get(failures)).toEqual([{ reason: "Invalid", message: "The document model returned an invalid graph extraction", step: "Graph",
      diagnostic: { stage: "extract", path: [], finishReason: "length", outputTokens: 2048, window: { part: 1, parts: 1 } } }])
    const processed = spans.find((span) => span.name === "rag.process")
    expect(Object.fromEntries([...(processed?.attributes ?? new Map<string, unknown>())].filter(([key]) => key.startsWith("efferent.knowledge.failure.")))).toEqual({
      "efferent.knowledge.failure.stage": "extract", "efferent.knowledge.failure.path": "$", "efferent.knowledge.failure.finish_reason": "length",
      "efferent.knowledge.failure.output_tokens": 2048, "efferent.knowledge.failure.window": "1/1",
    })
    const status = yield* knowledge.status(scope, job.id)
    expect(Option.map(status, (value) => [value.phase._tag, value.attempt])).toEqual(Option.some(["Complete", 2]))
    expect(Option.exists(Option.flatMap(status, (value) => value.stage), (stage) => stage.notes === undefined && stage.chunks.length === 1)).toBe(true)
    expect((yield* store.snapshot(scope)).graph.assertions.map((edge) => edge.predicate)).toEqual(["owns"])
    expect(yield* Ref.get(prompts)).toHaveLength(2)
  }))))

  test("chunks publish without the graph when extraction or review fails on every attempt", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    // Attempt 1: a valid extraction, then an invalid review. Attempt 2: the helper is unavailable.
    const { utility, prompts } = yield* scriptedUtility([JSON.stringify(atlasGraph), "not JSON"])
    const { knowledge, store } = yield* makeRag({ graph: true, review: true, maxAttempts: 2 }, undefined, undefined, utility)
    const job = yield* knowledge.ingest(enqueue("one", "Atlas owns Beacon."))
    expect(yield* knowledge.process(scope, 1)).toBe(1)
    const status = yield* knowledge.status(scope, job.id)
    expect(Option.map(status, (value) => [value.phase._tag, value.attempt])).toEqual(Option.some(["Complete", 2]))
    expect(Option.flatMap(status, (value) => value.stage).pipe(Option.map((stage) => stage.notes))).toEqual(Option.some([{ _tag: "GraphOmitted", reason: "Unavailable", message: "Document graph extraction failed" }]))
    expect(yield* Ref.get(prompts)).toHaveLength(3)
    const snapshot = yield* store.snapshot(scope)
    expect([snapshot.graph.entities, snapshot.graph.assertions]).toEqual([[], []])
    const found = yield* knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000 })
    expect(found.candidates.map((candidate) => candidate._tag === "Chunk" && candidate.chunk.provenance.source.id)).toEqual([KnowledgeSourceId.make("one")])
  }))))

  test("a source that is itself unavailable still fails, unretried and before any extraction", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const index = yield* makeKnowledgeIndexMemory()
    const store = { ...index, source: () => Effect.succeed(Option.none()) }
    const { utility, prompts } = yield* scriptedUtility([JSON.stringify(atlasGraph)])
    const { knowledge } = yield* makeRag({ graph: true, review: false, maxAttempts: 3 }, store, undefined, utility)
    const job = yield* knowledge.ingest(enqueue("one", "Atlas owns Beacon."))
    const failed = yield* Effect.result(knowledge.process(scope, 1))
    expect(failed._tag === "Failure" && failed.failure.reason).toBe("Invalid")
    const status = yield* knowledge.status(scope, job.id)
    expect(Option.map(status, (value) => [value.phase, value.attempt])).toEqual(Option.some([{ _tag: "Failed", reason: "Invalid", message: "The document source is unavailable", step: "Required" }, 1]))
    expect(yield* Ref.get(prompts)).toEqual([])
  }))))

  test("a transient failure is recorded as Unavailable and retried within maxAttempts", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const index = yield* makeKnowledgeIndexMemory()
    const failures = yield* Ref.make<ReadonlyArray<KnowledgeJobFailure>>([])
    const reads = yield* Ref.make(0)
    const store = {
      ...index,
      source: (...input: Parameters<typeof index.source>) => Ref.getAndUpdate(reads, (count) => count + 1).pipe(Effect.flatMap((count) => count === 0
        ? Effect.fail(new KnowledgeError({ reason: "Unavailable", message: "The document store was unreachable" }))
        : index.source(...input))),
      fail: (lease: Parameters<typeof index.fail>[0], failure: KnowledgeJobFailure) => Ref.update(failures, (all) => [...all, failure]).pipe(Effect.andThen(index.fail(lease, failure))),
    }
    const { knowledge } = yield* makeRag({ maxAttempts: 2 }, store)
    const job = yield* knowledge.ingest(enqueue("one", "Atlas owns Beacon."))
    expect(yield* knowledge.process(scope, 1)).toBe(1)
    expect(yield* Ref.get(failures)).toEqual([{ reason: "Unavailable", message: "The document store was unreachable", step: "Required" }])
    expect(Option.map(yield* knowledge.status(scope, job.id), (value) => [value.phase._tag, value.attempt])).toEqual(Option.some(["Complete", 2]))
  }))))

  test("a reviewer that returns the proposal from its prompt unchanged publishes the graph, with an absent and a known identity alike", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const frame = (tag: string, prompt: string) => new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt)?.[1] ?? ""
    const second = { entities: [
      { key: "b", name: "Beacon", type: "service", aliases: [], existing: "one:1:entity:b", spans: [{ start: 0, end: 6, quote: "Beacon" }] },
      { key: "c", name: "Cedar", type: "team", aliases: [], existing: null, spans: [{ start: 14, end: 19, quote: "Cedar" }] },
    ], memories: [], assertions: [{ key: "serves", subject: "b", predicate: "serves", object: { _tag: "Entity", key: "c" }, text: "Beacon serves Cedar", spans: [{ start: 0, end: 20, quote: "Beacon serves Cedar." }], validFrom: null, validTo: null, supersedes: [], supersession: "correction" }] }
    const extractions = [JSON.stringify(atlasGraph), JSON.stringify(second)]
    const prompts = yield* Ref.make<ReadonlyArray<string>>([])
    // Extraction answers from the script; review copies the proposal back verbatim.
    const utility = UtilityLlm.of({ complete: (prompt) => Ref.modify(prompts, (all): [number, ReadonlyArray<string>] => [all.filter((seen) => !seen.includes("<knowledge-proposal>")).length, [...all, prompt]]).pipe(
      Effect.map((extracted) => new UtilityCompletion({ text: prompt.includes("<knowledge-proposal>") ? frame("knowledge-proposal", prompt) : extractions[extracted] ?? "not JSON", usage: zeroUsage })),
    ) })
    const { knowledge, store } = yield* makeRag({ graph: true, review: true }, undefined, undefined, utility)
    const one = yield* knowledge.ingest(enqueue("one", "Atlas owns Beacon."))
    yield* knowledge.process(scope, 1)
    const two = yield* knowledge.ingest(enqueue("two", "Beacon serves Cedar."))
    yield* knowledge.process(scope, 1)
    const stages = yield* Effect.forEach([one, two], (job) => knowledge.status(scope, job.id).pipe(Effect.map(Option.map((value) => [value.phase._tag, Option.map(value.stage, (stage) => stage.notes ?? [])]))), { concurrency: 1 })
    expect(stages).toEqual([Option.some(["Complete", Option.some([])]), Option.some(["Complete", Option.some([])])])
    const graph = (yield* store.snapshot(scope)).graph
    expect([graph.entities.map((entity) => entity.name).toSorted(), graph.assertions.map((edge) => edge.predicate)]).toEqual([["Atlas", "Beacon", "Cedar"], ["owns", "serves"]])
    const proposals = (yield* Ref.get(prompts)).filter((prompt) => prompt.includes("<knowledge-proposal>")).map((prompt) => frame("knowledge-proposal", prompt))
    expect(proposals).toHaveLength(2)
    expect(proposals.some((proposal) => proposal.includes("\"_id\":\"Option\""))).toBe(false)
    expect(proposals[1]).toContain("\"existing\":\"one:1:entity:b\"")
    expect(proposals[1]).toContain("\"validFrom\":null,\"validTo\":null")
  }))))

  test("a document graph whose relations give null or no supersession while superseding nothing publishes, through review", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const frame = (tag: string, prompt: string) => new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt)?.[1] ?? ""
    const { supersession: _, ...owns } = atlasGraph.assertions[0]!
    // One relation's supersession is null, the other's is absent; review copies the proposal back verbatim.
    const graph = { ...atlasGraph, assertions: [{ ...owns, supersession: null }, { ...owns, key: "runs", predicate: "runs", text: "Atlas runs Beacon" }] }
    const utility = UtilityLlm.of({ complete: (prompt) => Effect.succeed(new UtilityCompletion({ text: prompt.includes("<knowledge-proposal>") ? frame("knowledge-proposal", prompt) : JSON.stringify(graph), usage: zeroUsage })) })
    const { knowledge, store } = yield* makeRag({ graph: true, review: true }, undefined, undefined, utility)
    const job = yield* knowledge.ingest(enqueue("one", "Atlas owns Beacon."))
    yield* knowledge.process(scope, 1)
    const status = yield* knowledge.status(scope, job.id)
    expect(Option.map(status, (value) => [value.phase._tag, Option.map(value.stage, (stage) => stage.notes ?? [])])).toEqual(Option.some(["Complete", Option.some([])]))
    const published = (yield* store.snapshot(scope)).graph
    expect(published.assertions.map((edge) => [edge.predicate, "replaces" in edge])).toEqual([["owns", false], ["runs", false]])
  }))))

  test("evidence review can remove unsupported personal material before document publication", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const draft = { entities: [], memories: [{ key: "bad", kind: "preference", text: "User prefers this document", entities: [], spans: [{ start: 0, end: 5, quote: "Guide" }], evidence: { _tag: "Stated" }, supersedes: [], supersession: "change" }], assertions: [] }
    const { utility, prompts } = yield* scriptedUtility([JSON.stringify(draft), JSON.stringify({ entities: [], memories: [], assertions: [] })])
    const { knowledge, store } = yield* makeRag({ graph: true, review: true }, undefined, undefined, utility)
    yield* knowledge.ingest(enqueue("reviewed", "Guide data."))
    expect(yield* knowledge.process(scope, 1)).toBe(1)
    expect((yield* store.snapshot(scope)).memories).toEqual([])
    expect((yield* Ref.get(prompts))).toHaveLength(2)
    expect((yield* knowledge.retrieve({ scope, query: "Guide", limit: 3, maxChars: 1000 })).candidates).toHaveLength(1)
  }))))
})

describe("bounded document extraction", () => {
  const filler = (word: string, count: number) => Array.from({ length: count }, (_, index) => `${word} ${index}.`).join(" ")
  const text = [`Atlas owns Beacon. ${filler("Planning", 60)}`, `Beacon serves Atlas. ${filler("Logistics", 55)}`, `Atlas depends on Beacon. ${filler("Review", 70)}`].join("\n\n")
  const frame = (tag: string, prompt: string) => new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt)?.[1] ?? ""
  const at = (part: string, quote: string) => ({ start: part.indexOf(quote), end: part.indexOf(quote) + quote.length, quote })
  const extraction = (part: string) => ({
    entities: [
      { key: "atlas", name: "Atlas", type: "project", aliases: [], existing: null, spans: [at(part, "Atlas")] },
      { key: "beacon", name: "Beacon", type: "service", aliases: [], existing: null, spans: [at(part, "Beacon")] },
    ],
    memories: [],
    assertions: [{ key: "related", subject: "atlas", predicate: "related_to", object: { _tag: "Entity", key: "beacon" }, text: "Atlas relates to Beacon", spans: [at(part, "Atlas")], validFrom: null, validTo: null, supersedes: [], supersession: "correction" }],
  })
  /** A helper that answers each purpose and records what each call was for. */
  const contextUtility = Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<{ readonly call: Option.Option<KnowledgeHelperCall>; readonly part: string }>>([])
    const utility = UtilityLlm.of({ complete: (prompt) => Effect.gen(function* () {
      const call = yield* Effect.service(CurrentKnowledgeHelperCall)
      yield* Ref.update(calls, (all) => [...all, { call, part: frame("knowledge-source", prompt) }])
      const purpose = Option.map(call, (value) => value.purpose)
      const reply = Option.contains(purpose, "extract") || Option.contains(purpose, "review") ? JSON.stringify(extraction(frame("knowledge-source", prompt)))
        : Option.contains(purpose, "plan") ? JSON.stringify({ queries: [], entities: [], validAt: null, knownAt: null })
        : "not JSON"
      return new UtilityCompletion({ text: reply, usage: zeroUsage })
    }) })
    return { utility, calls }
  })

  test("a long document is extracted in bounded calls whose merged graph cites exact source offsets", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { utility, calls } = yield* contextUtility
    const { knowledge, store } = yield* makeRag({ graph: true, review: true, maxExtractionChars: 1_000, maxHelperOutputTokens: 512 }, undefined, undefined, utility)
    yield* knowledge.ingest(enqueue("long", text))
    expect(yield* knowledge.process(scope, 1)).toBe(1)
    const windows = knowledgeExtractionWindows(text, 1_000)
    expect(windows.length).toBeGreaterThan(1)
    const seen = yield* Ref.get(calls)
    expect(seen.map(({ call }) => Option.map(call, (value) => value.purpose))).toEqual(windows.flatMap(() => [Option.some("extract"), Option.some("review")]))
    expect(seen.map(({ part }) => part)).toEqual(windows.flatMap((window) => [text.slice(window.start, window.end), text.slice(window.start, window.end)]))
    expect(seen.every(({ call }) => Option.exists(call, (value) => value.scope === scope
      && Option.exists(value.job, (job) => job.id === KnowledgeJobId.make("long:1") && job.attempt === 1)
      && Option.contains(value.maxOutputTokens, 512)))).toBe(true)
    const graph = (yield* store.snapshot(scope)).graph
    expect(graph.entities.map((entity) => entity.name)).toEqual(["Atlas", "Beacon"])
    expect(graph.assertions).toHaveLength(windows.length)
    const spans = [...graph.entities.flatMap((entity) => entity.provenance), ...graph.assertions.flatMap((assertion) => assertion.provenance)]
    expect(spans.every((span) => text.slice(span.start, span.end) === span.quote)).toBe(true)
    expect(graph.entities[0]?.provenance.map((span) => span.start)).toEqual(windows.map((window) => window.start + text.slice(window.start, window.end).indexOf("Atlas")))
  }))))

  test("search planning and reranking carry their purpose and scope but no job", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { utility, calls } = yield* contextUtility
    const { knowledge } = yield* makeRag({ queryPlanning: true, rerank: true }, undefined, undefined, utility)
    yield* knowledge.ingest(enqueue("guide", "stable evidence"))
    yield* knowledge.process(scope, 1)
    yield* knowledge.retrieve({ scope, query: "stable", limit: 3, maxChars: 1000 })
    expect((yield* Ref.get(calls)).map(({ call }) => call)).toEqual([
      Option.some({ purpose: "plan", scope, job: Option.none(), maxOutputTokens: Option.none() }),
      Option.some({ purpose: "rerank", scope, job: Option.none(), maxOutputTokens: Option.none() }),
    ])
  }))))
})

describe("document query assistance", () => {
  test("query planning and reranking are opt-in: by default a search makes no helper call", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    expect([ragDefaults.queryPlanning, ragDefaults.rerank]).toEqual([false, false])
    const helperCalls = (options: Partial<RagConfig>) => Effect.gen(function* () {
      const { utility, prompts } = yield* scriptedUtility([
        ...(options.queryPlanning === true ? [JSON.stringify({ queries: ["stable"], entities: [], validAt: null, knownAt: null })] : []),
        ...(options.rerank === true ? [JSON.stringify({ order: [] })] : []),
      ])
      const { knowledge } = yield* makeRag(options, undefined, undefined, utility)
      yield* knowledge.ingest(enqueue("guide", "stable evidence"))
      yield* knowledge.process(scope, 1)
      yield* knowledge.retrieve({ scope, query: "stable", limit: 3, maxChars: 1000 })
      return (yield* Ref.get(prompts)).map((prompt) => prompt.startsWith("Plan evidence retrieval") ? "plan" : prompt.startsWith("Rank candidate evidence") ? "rerank" : "other")
    })
    expect(yield* helperCalls({})).toEqual([])
    expect(yield* helperCalls({ queryPlanning: true })).toEqual(["plan"])
    expect(yield* helperCalls({ rerank: true })).toEqual(["rerank"])
    expect(yield* helperCalls({ queryPlanning: true, rerank: true })).toEqual(["plan", "rerank"])
  }))))

  test("planning adds complementary searches and reranking preserves only supplied cited evidence", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const index = yield* makeKnowledgeIndexMemory()
    const searches = yield* Ref.make<ReadonlyArray<string>>([])
    const store = { ...index, search: (query: Parameters<typeof index.search>[0]) => Ref.update(searches, (all) => [...all, query.query]).pipe(Effect.andThen(index.search(query))) }
    const { utility } = yield* scriptedUtility([
      JSON.stringify({ queries: ["beta"], entities: [], validAt: null, knownAt: null }),
      JSON.stringify({ order: ["chunk:b:1:chunk:0:13"] }),
    ])
    const { knowledge } = yield* makeRag({ queryPlanning: true, rerank: true }, store, undefined, utility)
    yield* knowledge.ingest(enqueue("a", "alpha evidence"))
    yield* knowledge.process(scope, 1)
    yield* knowledge.ingest(enqueue("b", "beta evidence"))
    yield* knowledge.process(scope, 1)
    const found = yield* knowledge.retrieve({ scope, query: "alpha", limit: 3, maxChars: 1000 })
    expect(yield* Ref.get(searches)).toEqual(["alpha", "beta"])
    expect(found.candidates).toHaveLength(1)
    expect(found.candidates[0]?._tag === "Chunk" && found.candidates[0].chunk.text).toBe("beta evidence")
  }))))

  test("with planning, each query's passage lists are ranked on their own after memories are left out", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const index = yield* makeKnowledgeIndexMemory()
    const passage = (name: string): KnowledgeCandidate => ({ _tag: "Chunk", score: 1, chunk: {
      id: KnowledgeChunkId.make(name), text: `${name} evidence`, embedding: Option.none(),
      provenance: { source: { id: KnowledgeSourceId.make(name), revision: 1 }, start: 0, end: name.length + 9, quote: `${name} evidence` },
    } })
    const remembered: KnowledgeCandidate = { _tag: "Memory", score: 1, memory: {
      id: KnowledgeMemoryId.make("remembered"), text: "remembered evidence", kind: "fact", entities: [], evidence: { _tag: "Stated" }, embedding: Option.none(),
      knownFrom: 1, knownTo: Option.none(), provenance: [{ source: { id: KnowledgeSourceId.make("remembered"), revision: 1 }, start: 0, end: 10, quote: "remembered" }],
    } }
    const [first, second, third, later] = ["first", "second", "third", "later"].map(passage) as [KnowledgeCandidate, KnowledgeCandidate, KnowledgeCandidate, KnowledgeCandidate]
    // The planned query's lists lead with a memory, which a document search leaves out before ranking: `later` is its rank 0.
    const lists = (query: KnowledgeSearch) => query.query === "alpha"
      ? { lexical: [first, second, third], semantic: [first, second, third] }
      : { lexical: [remembered, later, third], semantic: [remembered, later] }
    const store = { ...index, search: (query: KnowledgeSearch) => Effect.succeed(lists(query)) }
    const { utility } = yield* scriptedUtility([JSON.stringify({ queries: ["beta"], entities: [], validAt: null, knownAt: null })])
    const { knowledge } = yield* makeRag({ queryPlanning: true }, store, undefined, utility)
    const found = yield* knowledge.retrieve({ scope, query: "alpha", limit: 4, maxChars: 1000 })
    // third: 2/63 + 1/62; first and later: 2/61 each, tied by key; second: 2/62.
    expect(found.candidates.map((candidate) => [candidate._tag === "Chunk" ? String(candidate.chunk.id) : "", candidate.score])).toEqual([
      ["third", 1 / 63 + 1 / 63 + 1 / 62], ["first", 2 / 61], ["later", 2 / 61], ["second", 2 / 62],
    ])
  }))))

  test("invalid plans and fabricated reranker identities fall back to original hybrid evidence", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { utility } = yield* scriptedUtility(["not JSON", JSON.stringify({ order: ["invented"] })])
    const { knowledge } = yield* makeRag({ queryPlanning: true, rerank: true }, undefined, undefined, utility)
    yield* knowledge.ingest(enqueue("guide", "stable evidence"))
    yield* knowledge.process(scope, 1)
    const found = yield* knowledge.retrieve({ scope, query: "stable", limit: 3, maxChars: 1000 })
    expect(found.candidates).toHaveLength(1)
    expect(found.candidates[0]?._tag === "Chunk" && found.candidates[0].chunk.provenance.source.id).toBe(KnowledgeSourceId.make("guide"))
  }))))

  test("a stalled optional planner is bounded and retains lexical retrieval", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const utility = UtilityLlm.of({ complete: () => Effect.never })
    const { knowledge } = yield* makeRag({ queryPlanning: true, rerank: false, queryTimeoutMs: 10 }, undefined, undefined, utility)
    yield* knowledge.ingest(enqueue("guide", "stable evidence"))
    yield* knowledge.process(scope, 1)
    const searching = yield* Effect.forkChild(knowledge.retrieve({ scope, query: "stable", limit: 3, maxChars: 1000 }))
    yield* TestClock.adjust("10 millis")
    expect((yield* Fiber.join(searching)).candidates).toHaveLength(1)
  })).pipe(Effect.provide(TestClock.layer()))))
})
