import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import {
  KnowledgeAssertionId, KnowledgeEntityId, KnowledgeMemoryId, KnowledgeSourceId, KnowledgeVector,
  type KnowledgeCandidate, type KnowledgeMemory, type KnowledgeSource, type KnowledgeStage,
} from "./knowledge.entity.js"
import { fuseKnowledgeCandidates, knowledgeBm25, knowledgeCosine, knowledgeEngineId, knowledgeScopeKey, traverseKnowledgeGraph, validateKnowledgeStage } from "./knowledge.entity.functions.js"

const scope = { owner: "owner", namespace: "assistant", collection: "memory" }
const source = (name: string): KnowledgeSource => ({ scope, ref: { id: KnowledgeSourceId.make(name), revision: 1 }, text: "Visits the cafe every Monday", occurredAt: 1, recordedAt: 2, metadata: {} })
const memory = (name: string): KnowledgeMemory => ({
  id: KnowledgeMemoryId.make(name), text: "Visits the cafe", kind: "action", entities: [], evidence: { _tag: "Stated" }, embedding: Option.none(), knownFrom: 2, knownTo: Option.none(),
  provenance: [{ source: source(name).ref, start: 0, end: 10, quote: "Visits the" }],
})
const emptyGraph = { entities: [], assertions: [], truncated: false }
const stage = (record: KnowledgeMemory): KnowledgeStage => ({ expectedVersion: 0, memories: [record], chunks: [], entities: [], assertions: [], retireMemories: [], retireAssertions: [] })

test("scope keys resist delimiters and Unicode boundary confusion", () => {
  expect(knowledgeScopeKey({ owner: "a/b", namespace: "c", collection: "d" })).not.toBe(knowledgeScopeKey({ owner: "a", namespace: "b/c", collection: "d" }))
})
test("engine ids name the processor and its embedding space, distinct for every space", () => {
  const space = { model: "embed", version: "1", dimensions: 768 }
  expect(knowledgeEngineId("rag:1", space)).toBe("rag:1/embed/1/768")
  expect(knowledgeEngineId("rag:1", { ...space, model: "vendor/embed" })).toBe("rag:1/vendor%2Fembed/1/768")
  const ids = [
    knowledgeEngineId("rag:1", space), knowledgeEngineId("memory:1", space),
    knowledgeEngineId("rag:1", { ...space, model: "other" }), knowledgeEngineId("rag:1", { ...space, version: "2" }),
    knowledgeEngineId("rag:1", { ...space, dimensions: 1536 }),
    knowledgeEngineId("rag:1", { ...space, model: "a/b", version: "c" }), knowledgeEngineId("rag:1", { ...space, model: "a", version: "b/c" }),
    knowledgeEngineId("rag:1", { ...space, model: "a%2Fb", version: "c" }),
  ]
  expect(new Set(ids).size).toBe(ids.length)
})
test("vectors reject mismatched dimensions and nonfinite values at the schema edge", async () => {
  const decode = Schema.decodeUnknownEffect(KnowledgeVector)
  const mismatch = await Effect.runPromise(Effect.option(decode({ space: { model: "m", version: "1", dimensions: 2 }, values: [1] })))
  const nonfinite = await Effect.runPromise(Effect.option(decode({ space: { model: "m", version: "1", dimensions: 1 }, values: [Infinity] })))
  expect(Option.isNone(mismatch)).toBe(true)
  expect(Option.isNone(nonfinite)).toBe(true)
})
test("inferred routines need three independent sources and derivations cannot cycle", () => {
  const memories = [memory("one"), memory("two"), memory("three")]
  const routine: KnowledgeMemory = { ...memory("routine"), kind: "routine", provenance: memories.flatMap((item) => item.provenance), evidence: { _tag: "Inferred", supports: memories.map((item) => item.id) } }
  const sources = [source("one"), source("two"), source("three")]
  expect(Option.isNone(validateKnowledgeStage(stage(routine), { version: 0, memories, graph: emptyGraph }, sources))).toBe(true)
  const splitEpisode = sources.map((entry) => ({ ...entry, metadata: { episode: "same-committed-turn" } }))
  expect(Option.isSome(validateKnowledgeStage(stage(routine), { version: 0, memories, graph: emptyGraph }, splitEpisode))).toBe(true)
  const independentEpisodes = sources.map((entry) => ({ ...entry, metadata: { episode: `turn:${entry.ref.id}` } }))
  expect(Option.isNone(validateKnowledgeStage(stage(routine), { version: 0, memories, graph: emptyGraph }, independentEpisodes))).toBe(true)
  expect(Option.isSome(validateKnowledgeStage(stage({ ...routine, evidence: { _tag: "Inferred", supports: [memories[0]!.id, memories[1]!.id] } }), { version: 0, memories, graph: emptyGraph }, sources))).toBe(true)
  const cyclic = [{ ...memory("one"), evidence: { _tag: "Inferred" as const, supports: [KnowledgeMemoryId.make("two")] } }, { ...memory("two"), evidence: { _tag: "Inferred" as const, supports: [KnowledgeMemoryId.make("one")] } }]
  expect(Option.isSome(validateKnowledgeStage({ ...stage(cyclic[0]!), memories: cyclic }, { version: 0, memories: [], graph: emptyGraph }, sources))).toBe(true)
})
test("publication validation rejects reversed intervals and inactive supporting records", () => {
  const original = memory("one")
  const invalid = { ...original, knownFrom: 10, knownTo: Option.some(9) }
  expect(Option.isSome(validateKnowledgeStage(stage(invalid), { version: 0, memories: [], graph: emptyGraph }, [source("one")]))).toBe(true)
  const derived: KnowledgeMemory = { ...memory("two"), evidence: { _tag: "Inferred", supports: [original.id] } }
  expect(Option.isSome(validateKnowledgeStage(stage(derived), { version: 0, memories: [{ ...original, knownTo: Option.some(10) }], graph: emptyGraph }, [source("one"), source("two")]))).toBe(true)
  expect(Option.isSome(validateKnowledgeStage({ ...stage(derived), retireMemories: [original.id] }, { version: 0, memories: [original], graph: emptyGraph }, [source("one"), source("two")]))).toBe(true)
})
test("rank fusion rewards agreement, deduplicates and obeys the complete-result character budget", () => {
  const candidate = (id: string): KnowledgeCandidate => ({ _tag: "Memory", memory: memory(id), score: 1 })
  const one = candidate("one")
  const two = candidate("two")
  const fused = fuseKnowledgeCandidates({ lexical: [one, two], semantic: [two] }, 10, 100)
  expect(fused.map((entry) => entry._tag === "Memory" ? String(entry.memory.id) : String(entry.chunk.id))).toEqual(["two", "one"])
  expect(fuseKnowledgeCandidates({ lexical: [one, two], semantic: [two] }, 10, 20)).toHaveLength(1)
})
test("BM25 finds exact tokens and cosine defines zero norms without NaN", () => {
  const scores = knowledgeBm25("ticket-123", ["ticket-123 resolved", "unrelated ticket"])
  expect(scores[0]).toBeGreaterThan(0)
  expect(scores[1]).toBe(0)
  const space = { model: "test", version: "1", dimensions: 2 }
  expect(knowledgeCosine({ space, values: [0, 0] }, { space, values: [1, 0] })).toBe(0)
})
test("graph intervals are half-open on both timelines and traversal cannot cross invalid edges", () => {
  const ids = [KnowledgeEntityId.make("one"), KnowledgeEntityId.make("two"), KnowledgeEntityId.make("three")]
  const entities = ids.map((id) => ({ id, name: id, type: "thing", aliases: [], provenance: memory("one").provenance }))
  const edge = { id: KnowledgeAssertionId.make("edge"), subject: ids[0]!, predicate: "at", object: { _tag: "Entity" as const, entityId: ids[1]! }, text: "evidence", provenance: memory("one").provenance, knownFrom: 10, knownTo: Option.some(20), validFrom: Option.some(5), validTo: Option.some(15) }
  const query = { scope, seeds: [ids[0]!], perspective: { validAt: 14, knownAt: 19 }, depth: 2, limit: 10 }
  const graph = { entities, assertions: [edge], truncated: false }
  expect(traverseKnowledgeGraph(graph, query).assertions).toHaveLength(1)
  expect(traverseKnowledgeGraph(graph, { ...query, perspective: { validAt: 15, knownAt: 19 } }).assertions).toHaveLength(0)
  expect(traverseKnowledgeGraph(graph, { ...query, perspective: { validAt: 14, knownAt: 20 } }).assertions).toHaveLength(0)
})
