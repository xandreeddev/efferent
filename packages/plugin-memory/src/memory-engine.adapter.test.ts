import { describe, expect, test } from "bun:test"
import { EmbeddingModel } from "effect/ai"
import { Clock, Context, Effect, Layer, Option, Ref } from "effect"
import { KnowledgeJobId, KnowledgeSourceId, LongTermMemory, MemoryStore, knowledgeExtractionWindows } from "@xandreed/core"
import { MemoryLive } from "./memory-engine.adapter.js"
import { memoryDefaults } from "./memory.entity.js"
import type { MemoryConfig } from "./memory.entity.js"
import { fixtureEnqueue, fixtureExtraction, fixtureScope, makeMemoryFixture } from "./memory.testing.js"

describe("native memory engine", () => {
  test("capture is durable before processing, then facts and graph evidence are recalled across sessions", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const text = "I prefer tea."
    const fixture = yield* makeMemoryFixture([JSON.stringify(fixtureExtraction(text))])
    const job = yield* fixture.memory.capture(fixtureEnqueue("session-a", text))
    expect(job.phase._tag).toBe("Queued")
    expect((yield* fixture.store.snapshot(fixtureScope)).memories).toEqual([])
    expect(yield* fixture.memory.process(fixtureScope, 10)).toBe(1)
    const result = yield* fixture.memory.recall({ scope: fixtureScope, query: "preferred drink", limit: 8, maxChars: 8_000 })
    expect(result.candidates.map((candidate) => candidate._tag)).toEqual(["Memory"])
    expect(result.graph.assertions.map((assertion) => assertion.predicate)).toEqual(["prefers"])
    expect((yield* fixture.memory.profile(fixtureScope)).map((memory) => memory.text)).toEqual([text])
    const other = yield* fixture.memory.recall({ scope: { ...fixtureScope, owner: "other-owner" }, query: "preferred drink", limit: 8, maxChars: 8_000 })
    expect(other).toEqual({ candidates: [], graph: { entities: [], assertions: [], truncated: false }, sources: [] })
  }))))

  test("duplicate capture retains one job and runs extraction once", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const text = "I prefer tea."
    const fixture = yield* makeMemoryFixture([JSON.stringify(fixtureExtraction(text))])
    yield* fixture.memory.capture(fixtureEnqueue("same", text))
    yield* fixture.memory.capture(fixtureEnqueue("same", text))
    yield* fixture.memory.process(fixtureScope, 10)
    yield* fixture.memory.capture(fixtureEnqueue("same", text))
    expect(yield* fixture.memory.process(fixtureScope, 10)).toBe(0)
    expect((yield* Ref.get(fixture.calls)).length).toBe(1)
    expect((yield* fixture.store.snapshot(fixtureScope)).memories).toHaveLength(1)
  }))))

  test("invalid model output leaves a failed retryable job and publishes no facts", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeMemoryFixture(["This is not JSON"])
    const job = yield* fixture.memory.capture(fixtureEnqueue("invalid", "I prefer tea."))
    const result = yield* fixture.memory.process(fixtureScope, 1).pipe(Effect.result)
    expect(result._tag).toBe("Failure")
    expect(Option.map(yield* fixture.memory.status(fixtureScope, job.id), (status) => status.phase._tag)).toEqual(Option.some("Failed"))
    expect((yield* fixture.store.snapshot(fixtureScope)).memories).toEqual([])
    expect(yield* fixture.memory.source(fixtureScope, job.source)).not.toEqual(Option.none())
  }))))

  test("explicit corrections supersede memories while retaining their historical evidence", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const previous = "I prefer tea."
    const next = "I now prefer coffee."
    const original = fixtureExtraction(previous)
    const corrected = { ...fixtureExtraction(next),
      entities: [{ ...fixtureExtraction(next).entities[0]!, existing: "old:1:entity:person" }],
      memories: [{ ...fixtureExtraction(next).memories[0]!, supersedes: ["old:1:memory:preference"] }],
      assertions: [{ ...fixtureExtraction(next).assertions[0]!, object: { _tag: "Value", value: "coffee" }, supersedes: ["old:1:assertion:prefers"] }],
    }
    const fixture = yield* makeMemoryFixture([JSON.stringify(original), JSON.stringify(corrected)])
    yield* fixture.memory.capture(fixtureEnqueue("old", previous))
    yield* fixture.memory.process(fixtureScope, 1)
    yield* fixture.memory.capture(fixtureEnqueue("new", next))
    yield* fixture.memory.process(fixtureScope, 1)
    const records = (yield* fixture.store.snapshot(fixtureScope)).memories
    expect(records).toHaveLength(2)
    expect(records.filter((memory) => Option.isNone(memory.knownTo)).map((memory) => memory.text)).toEqual([next])
    yield* fixture.memory.forget(fixtureScope, KnowledgeSourceId.make("old"))
    expect((yield* fixture.memory.recall({ scope: fixtureScope, query: "tea", limit: 8, maxChars: 8_000 })).candidates).toEqual([])
    expect((yield* fixture.memory.capture(fixtureEnqueue("old", previous)).pipe(Effect.result))._tag).toBe("Failure")
  }))))

  test("world changes retain a revised historical graph interval at current knowledge time", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const oldText = "I prefer tea."
    const newText = "I changed to coffee at time 50."
    const original = fixtureExtraction(oldText)
    const changed = { ...fixtureExtraction(newText),
      entities: [{ ...fixtureExtraction(newText).entities[0]!, existing: "earlier:1:entity:person" }],
      assertions: [{ ...fixtureExtraction(newText).assertions[0]!, object: { _tag: "Value", value: "coffee" }, validFrom: 50, supersedes: ["earlier:1:assertion:prefers"], supersession: "change" }],
    }
    const fixture = yield* makeMemoryFixture([JSON.stringify(original), JSON.stringify(changed)])
    yield* fixture.memory.capture(fixtureEnqueue("earlier", oldText))
    yield* fixture.memory.process(fixtureScope, 1)
    yield* fixture.memory.capture(fixtureEnqueue("later", newText))
    yield* fixture.memory.process(fixtureScope, 1)
    const now = yield* Clock.currentTimeMillis
    const past = yield* fixture.memory.recall({ scope: fixtureScope, query: "User", limit: 8, maxChars: 8_000, graph: { perspective: { validAt: 20, knownAt: now }, depth: 2 } })
    expect(past.graph.assertions.map((assertion) => assertion.object)).toEqual([{ _tag: "Value", value: "tea" }])
  }))))

  test("query planning and reranking are opt-in: by default recall makes no helper call", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    expect([memoryDefaults.queryPlanning, memoryDefaults.rerank]).toEqual([false, false])
    const text = "I prefer tea."
    const helperCalls = (options: Partial<MemoryConfig>) => Effect.gen(function* () {
      const fixture = yield* makeMemoryFixture([
        JSON.stringify(fixtureExtraction(text)),
        ...(options.queryPlanning === true ? [JSON.stringify({ queries: ["tea"], entities: [], validAt: null, knownAt: null })] : []),
        ...(options.rerank === true ? [JSON.stringify({ order: [] })] : []),
      ], options)
      yield* fixture.memory.capture(fixtureEnqueue("helpers", text))
      yield* fixture.memory.process(fixtureScope, 1)
      const processed = (yield* Ref.get(fixture.calls)).length
      yield* fixture.memory.recall({ scope: fixtureScope, query: "tea", limit: 8, maxChars: 8_000 })
      return (yield* Ref.get(fixture.calls)).slice(processed).map((prompt) => prompt.startsWith("Plan evidence retrieval") ? "plan" : prompt.startsWith("Rank candidate evidence") ? "rerank" : "other")
    })
    expect(yield* helperCalls({})).toEqual([])
    expect(yield* helperCalls({ queryPlanning: true })).toEqual(["plan"])
    expect(yield* helperCalls({ rerank: true })).toEqual(["rerank"])
    expect(yield* helperCalls({ queryPlanning: true, rerank: true })).toEqual(["plan", "rerank"])
  }))))

  test("explicit graph opt-out performs no graph traversal", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const text = "I prefer tea."
    const fixture = yield* makeMemoryFixture([JSON.stringify(fixtureExtraction(text))])
    yield* fixture.memory.capture(fixtureEnqueue("graph-control", text))
    yield* fixture.memory.process(fixtureScope, 1)
    const traversals = yield* Ref.make(0)
    const services = Context.add(fixture.services, MemoryStore, { ...fixture.store, traverse: (query) => Ref.update(traversals, (count) => count + 1).pipe(Effect.andThen(fixture.store.traverse(query))) })
    const context = yield* Layer.build(MemoryLive(fixture.config).pipe(Layer.provide(Layer.succeedContext(services))))
    const memory = Context.get(context, LongTermMemory)
    const result = yield* memory.recall({ scope: fixtureScope, query: "tea", limit: 8, maxChars: 8_000, graph: false })
    expect(result.candidates).toHaveLength(1)
    expect(result.graph).toEqual({ entities: [], assertions: [], truncated: false })
    expect(yield* Ref.get(traversals)).toBe(0)
  }))))

  test("consolidation ablation keeps stated evidence and ignores inferred updates", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const text = "I prefer tea."
    const extracted = fixtureExtraction(text)
    const response = { ...extracted, memories: [
      { ...extracted.memories[0]!, supersedes: ["unknown-old-fact"] },
      { ...extracted.memories[0]!, key: "inference", kind: "profile", evidence: { _tag: "Inferred", supports: ["unknown-support"] }, supersedes: [] },
    ] }
    const fixture = yield* makeMemoryFixture([JSON.stringify(response)], { consolidate: false })
    yield* fixture.memory.capture(fixtureEnqueue("ablation", text))
    yield* fixture.memory.process(fixtureScope, 1)
    const snapshot = yield* fixture.store.snapshot(fixtureScope)
    expect(snapshot.memories.map((memory) => memory.kind)).toEqual(["preference"])
    expect((yield* Ref.get(fixture.calls))[0]).toContain("Consolidation is disabled for this run.")
  }))))
})

describe("bounded memory extraction", () => {
  const filler = (word: string, count: number) => Array.from({ length: count }, (_, index) => `${word} ${index}.`).join(" ")
  const text = [`User: I prefer tea. ${filler("Chat", 70)}`, `User: I prefer green tea in the morning. ${filler("Talk", 60)}`, `User: I prefer tea without sugar. ${filler("Note", 75)}`].join("\n\n")
  const sourceOf = (prompt: string) => /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
  /** One stated preference per part: its first sentence, at offsets within the part. */
  const reply = (prompt: string, call: Option.Option<{ readonly purpose: string }>) => {
    const purpose = Option.map(call, (value) => value.purpose)
    if (Option.contains(purpose, "plan")) return JSON.stringify({ queries: ["tea"], entities: [], validAt: null, knownAt: null })
    if (!Option.contains(purpose, "extract") && !Option.contains(purpose, "review")) return "not JSON"
    const part = sourceOf(prompt)
    const sentence = part.slice(part.indexOf("I prefer"), part.indexOf(".", part.indexOf("I prefer")) + 1)
    const span = { start: part.indexOf(sentence), end: part.indexOf(sentence) + sentence.length, quote: sentence }
    return JSON.stringify({
      entities: [{ key: "user", name: "User", type: "person", aliases: [], existing: null, spans: [{ start: part.indexOf("User"), end: part.indexOf("User") + 4, quote: "User" }] }],
      memories: [{ key: "preference", kind: "preference", text: sentence, entities: ["user"], spans: [span], evidence: { _tag: "Stated" }, supersedes: [] }],
      assertions: [],
    })
  }

  test("a long source makes several bounded calls, each with its job context, and keeps exact provenance", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeMemoryFixture(reply, { review: true, maxExtractionChars: 1_000, maxSourceChars: 4_000, maxHelperOutputTokens: 256 })
    const job = yield* fixture.memory.capture(fixtureEnqueue("long", text))
    expect(yield* fixture.memory.process(fixtureScope, 1)).toBe(1)
    const windows = knowledgeExtractionWindows(text, 1_000)
    expect(windows.length).toBeGreaterThan(1)
    const prompts = yield* Ref.get(fixture.calls)
    expect(prompts).toHaveLength(windows.length * 2)
    expect(prompts.map(sourceOf)).toEqual(windows.flatMap((window) => [text.slice(window.start, window.end), text.slice(window.start, window.end)]))
    expect(yield* Ref.get(fixture.helperCalls)).toEqual(windows.flatMap(() => ["extract" as const, "review" as const]).map((purpose) => Option.some({
      purpose, scope: fixtureScope, job: Option.some({ id: KnowledgeJobId.make("job:long"), attempt: 1 }), maxOutputTokens: Option.some(256),
    })))
    expect(job.id).toBe(KnowledgeJobId.make("job:long"))
    const snapshot = yield* fixture.store.snapshot(fixtureScope)
    expect(snapshot.memories.map((memory) => memory.text)).toEqual(["I prefer tea.", "I prefer green tea in the morning.", "I prefer tea without sugar."].slice(0, windows.length))
    expect(snapshot.memories.flatMap((memory) => memory.provenance).every((span) => text.slice(span.start, span.end) === span.quote)).toBe(true)
    expect(snapshot.graph.entities).toHaveLength(1)
  }))))

  test("recall's planning and reranking calls carry their purpose and scope but no job", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeMemoryFixture(reply, { queryPlanning: true, rerank: true })
    yield* fixture.memory.capture(fixtureEnqueue("short", "User: I prefer tea."))
    yield* fixture.memory.process(fixtureScope, 1)
    yield* fixture.memory.recall({ scope: fixtureScope, query: "drink", limit: 8, maxChars: 8_000 })
    expect((yield* Ref.get(fixture.helperCalls)).slice(1)).toEqual([
      Option.some({ purpose: "plan", scope: fixtureScope, job: Option.none(), maxOutputTokens: Option.none() }),
      Option.some({ purpose: "rerank", scope: fixtureScope, job: Option.none(), maxOutputTokens: Option.none() }),
    ])
  }))))
})
