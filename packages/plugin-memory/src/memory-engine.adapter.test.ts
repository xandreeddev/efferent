import { describe, expect, test } from "bun:test"
import { EmbeddingModel } from "effect/ai"
import { Clock, Context, Effect, Layer, Option, Ref } from "effect"
import { KnowledgeSourceId, LongTermMemory, MemoryStore } from "@xandreed/core"
import { MemoryLive } from "./memory-engine.adapter.js"
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
    expect(other).toEqual({ candidates: [], graph: { entities: [], assertions: [], truncated: false } })
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
