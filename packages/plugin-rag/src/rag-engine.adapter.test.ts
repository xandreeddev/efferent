import { describe, expect, test } from "bun:test"
import { Clock, Effect, Fiber, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { CurrentKnowledgeHelperCall, KnowledgeJobId, KnowledgeSourceId, knowledgeEngineId, knowledgeExtractionWindows, makeKnowledgeIndexMemory, UtilityCompletion, UtilityLlm, zeroUsage } from "@xandreed/core"
import type { KnowledgeHelperCall } from "@xandreed/core"
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
    expect(job.engine).toBe(knowledgeEngineId("rag:1", { model: "host", version: "1", dimensions: 2 }))
    expect(otherJob.engine).toBe(knowledgeEngineId("rag:1", { model: "other-embedder", version: "1", dimensions: 2 }))
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
    yield* knowledge.ingest(enqueue("one", "Atlas owns Beacon."))
    yield* knowledge.process(scope, 1)
    yield* knowledge.ingest(enqueue("two", "Beacon serves Cedar."))
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
    const before = yield* knowledge.retrieve({ scope, query: "Atlas", limit: 3, maxChars: 1000, graph: { perspective: { ...perspective, validAt: 9 }, depth: 2 } })
    expect(before.graph.assertions).toEqual([])
  }))))

  test("graph extraction requires a utility model and cannot create personal memories from documents", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const absent = yield* Effect.result(makeRag({ graph: true }))
    expect(absent._tag).toBe("Failure")
    const { utility } = yield* scriptedUtility([JSON.stringify({ entities: [], memories: [{ key: "bad", kind: "preference", text: "User prefers this document", entities: [], spans: [{ start: 0, end: 5, quote: "Guide" }], evidence: { _tag: "Stated" }, supersedes: [] }], assertions: [] })])
    const { knowledge, store } = yield* makeRag({ graph: true, review: false }, undefined, undefined, utility)
    yield* knowledge.ingest(enqueue("bad", "Guide data."))
    expect((yield* Effect.result(knowledge.process(scope, 1)))._tag).toBe("Failure")
    expect((yield* store.snapshot(scope)).memories).toEqual([])
  }))))

  test("evidence review can remove unsupported personal material before document publication", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const draft = { entities: [], memories: [{ key: "bad", kind: "preference", text: "User prefers this document", entities: [], spans: [{ start: 0, end: 5, quote: "Guide" }], evidence: { _tag: "Stated" }, supersedes: [] }], assertions: [] }
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
