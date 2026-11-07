import { expect, test } from "bun:test"
import { Array as Arr, Effect, Option, Schema } from "effect"
import {
  KnowledgeAssertionId, KnowledgeChunkId, KnowledgeEntityId, KnowledgeJob, KnowledgeJobId, KnowledgeMemoryId,
  KnowledgeRecallResult, KnowledgeSourceId, KnowledgeVector, type KnowledgeErrorReason, type KnowledgeFailureStep, KnowledgeMetadataFilter,
  KnowledgeSearch, KnowledgeMemory as KnowledgeMemoryCodec,
  type KnowledgeCandidate, type KnowledgeCorroboration, type KnowledgeMemory, type KnowledgeSource, type KnowledgeStage,
} from "./knowledge.entity.js"
import {
  citedKnowledgeSources, citesKnowledgeSources, fuseKnowledgeCandidates, isRetryableKnowledgeFailure, knowledgeBm25, knowledgeCandidateWithin,
  knowledgeCosine, knowledgeEngineId, knowledgeScopeKey, narrowKnowledgeGraph, traverseKnowledgeGraph, validateKnowledgeStage,
  admitsKnowledgeSource, citesAdmittedKnowledge, knowledgeCandidateAdmitted, knowledgeNarrowingAdmits, matchesKnowledgeMetadata, narrowKnowledgeGraphBy, knowledgeRecordDate,
  knowledgeEpisodeCount, knowledgeMemoryMentions, knowledgeMemorySupport, corroborateKnowledgeMemory, stripKnowledgeRevisions, narrowKnowledgeMemory, knowledgeMemoryIsPast, knowledgeProfileOrder,
} from "./knowledge.entity.functions.js"

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
test("rank fusion ranks each query's lists on their own and sums a candidate's votes across them", () => {
  const candidate = (id: string): KnowledgeCandidate => ({ _tag: "Memory", memory: memory(id), score: 0 })
  const ids = (fused: ReadonlyArray<KnowledgeCandidate>) => fused.map((entry) => [entry._tag === "Memory" ? String(entry.memory.id) : String(entry.chunk.id), entry.score])
  const [first, second, third, later] = [candidate("first"), candidate("second"), candidate("third"), candidate("later")]
  // The second query finds `later` first: rank 0 of its list, 1/61, not rank 3 of the first query's list after it.
  const asked = { lexical: [first, second, third], semantic: [] }
  const planned = { lexical: [later], semantic: [] }
  expect(ids(fuseKnowledgeCandidates([asked, planned], 10, 1_000))).toEqual([["first", 1 / 61], ["later", 1 / 61], ["second", 1 / 62], ["third", 1 / 63]])
  // A candidate both queries find sums both queries' votes: 1/63 from the first, 1/62 from the second.
  const both = fuseKnowledgeCandidates([asked, { lexical: [later, third], semantic: [] }], 10, 1_000)
  expect(ids(both)).toEqual([["third", 1 / 63 + 1 / 62], ["first", 1 / 61], ["later", 1 / 61], ["second", 1 / 62]])
  // One pair, alone or in a list, fuses as before: per arm, a candidate's first rank there; a single list's repeat adds nothing.
  const pair = { lexical: [first, second, first], semantic: [second, third] }
  expect(ids(fuseKnowledgeCandidates([pair], 10, 1_000))).toEqual(ids(fuseKnowledgeCandidates(pair, 10, 1_000)))
  expect(ids(fuseKnowledgeCandidates(pair, 10, 1_000))).toEqual([["second", 1 / 62 + 1 / 61], ["first", 1 / 61], ["third", 1 / 62]])
  // Limit and character budget select after scoring; no pair fuses to nothing.
  expect(ids(fuseKnowledgeCandidates([asked, planned], 2, 1_000))).toEqual([["first", 1 / 61], ["later", 1 / 61]])
  expect(fuseKnowledgeCandidates([], 10, 1_000)).toEqual([])
})
test("a weight multiplies each fused score before ranking and selection; a weight of 1 fuses plainly", () => {
  const candidate = (id: string): KnowledgeCandidate => ({ _tag: "Memory", memory: memory(id), score: 0 })
  const ids = (fused: ReadonlyArray<KnowledgeCandidate>) => fused.map((entry) => [entry._tag === "Memory" ? String(entry.memory.id) : String(entry.chunk.id), entry.score])
  const pair = { lexical: [candidate("first"), candidate("second"), candidate("third")], semantic: [candidate("first"), candidate("second"), candidate("third")] }
  expect(ids(fuseKnowledgeCandidates(pair, 10, 1_000, () => 1))).toEqual(ids(fuseKnowledgeCandidates(pair, 10, 1_000)))
  // The weight sees each candidate as its lists hold it; the selected candidate carries its weighted score.
  const weighted = fuseKnowledgeCandidates(pair, 2, 1_000, (entry) => entry._tag === "Memory" && entry.memory.id === "third" ? 1.1 : 1)
  expect(ids(weighted)).toEqual([["third", 1.1 * 2 / 63], ["first", 2 / 61]])
})
test("a memory's mentions are the revisions that state it; one stored before mentions reads them from its provenance", () => {
  const ref = (name: string, revision = 1) => ({ id: KnowledgeSourceId.make(name), revision })
  const span = (name: string, revision = 1) => ({ source: ref(name, revision), start: 0, end: 5, quote: "Visit" })
  const stated: KnowledgeMemory = { ...memory("stated"), provenance: [span("own"), span("entity"), span("own")] }
  // Stated, stored before mentions: the revision its first span cites, never its entities' evidence.
  expect(knowledgeMemoryMentions(stated)).toEqual([ref("own")])
  // Inferred, stored before mentions: every revision its provenance cites, once each.
  expect(knowledgeMemoryMentions({ ...stated, provenance: [...stated.provenance, span("support", 2)], evidence: { _tag: "Inferred", supports: [KnowledgeMemoryId.make("other")] } }))
    .toEqual([ref("own"), ref("entity"), ref("support", 2)])
  // Stored mentions win, once each.
  expect(knowledgeMemoryMentions({ ...stated, mentions: [ref("own"), ref("entity"), ref("own")] })).toEqual([ref("own"), ref("entity")])
})
test("support counts the distinct episodes of the live mentioned revisions, by source when a revision names no episode", () => {
  const ref = (name: string) => ({ id: KnowledgeSourceId.make(name), revision: 1 })
  const span = (name: string) => ({ source: ref(name), start: 0, end: 5, quote: "Visit" })
  const info = (name: string, occurredAt: number, episode?: string) => ({ ref: ref(name), occurredAt, recordedAt: occurredAt, metadata: episode === undefined ? {} : { episode } })
  // Four revisions: two parts of one turn, a turn of its own, and a revision that names no episode. The entity's revision is never a mention.
  const inferred: KnowledgeMemory = {
    ...memory("inferred"), kind: "preference", evidence: { _tag: "Inferred", supports: [KnowledgeMemoryId.make("support")] },
    provenance: ["part-one", "part-two", "later", "plain", "entity"].map(span), mentions: ["part-one", "part-two", "later", "plain"].map(ref),
  }
  const infos = [info("part-one", 30, "turn:a"), info("part-two", 10, "turn:a"), info("later", 50, "turn:b"), info("plain", 20), info("entity", 90, "turn:c")]
  expect(knowledgeMemorySupport(inferred, infos)).toEqual(Option.some({ episodes: 3, sources: 4, firstSeen: 10, lastSeen: 50 }))
  // A blank episode counts by source, as the routine rule does.
  expect(knowledgeEpisodeCount([ref("part-one"), ref("plain")], [info("part-one", 1, " "), info("plain", 1, " ")])).toBe(2)
  // A forgotten revision (its info missing) never counts; with none left there is no support.
  expect(knowledgeMemorySupport(inferred, infos.filter((entry) => entry.ref.id !== "later"))).toEqual(Option.some({ episodes: 2, sources: 3, firstSeen: 10, lastSeen: 30 }))
  expect(knowledgeMemorySupport(inferred, [info("entity", 90, "turn:c")])).toEqual(Option.none())
  // Stored before mentions: a stated memory counts only the revision its first span cites, however many entities its provenance evidences.
  const { mentions: _mentions, ...legacy } = { ...inferred, evidence: { _tag: "Stated" as const } }
  expect(knowledgeMemorySupport(legacy, infos)).toEqual(Option.some({ episodes: 1, sources: 1, firstSeen: 30, lastSeen: 30 }))
})
test("the profile order puts more episodes first, then the latest said, then the lower id, and a memory without support last", () => {
  const supported = (name: string, episodes: number, lastSeen: number) => ({ ...memory(name), support: { episodes, sources: episodes, firstSeen: 1, lastSeen } })
  // In id order, and in the order a store would insert them: neither is the profile's order.
  const profile = [memory("a-unsupported"), supported("b-once-old", 1, 10), supported("c-once-new", 1, 40), supported("d-twice", 2, 20), supported("e-once-new", 1, 40), supported("f-thrice", 3, 5)]
  expect(Arr.sort(profile, knowledgeProfileOrder).map((record) => String(record.id))).toEqual(["f-thrice", "d-twice", "c-once-new", "e-once-new", "b-once-old", "a-unsupported"])
  expect(Arr.sort(profile.toReversed(), knowledgeProfileOrder)).toEqual(Arr.sort(profile, knowledgeProfileOrder))
})
test("a memory stored before mentions decodes without them, and one stored with them keeps them", () => Effect.runPromise(Effect.gen(function* () {
  const codec = Schema.fromJsonString(KnowledgeMemoryCodec)
  const legacy = yield* Schema.encodeEffect(codec)(memory("legacy"))
  const decoded = yield* Schema.decodeUnknownEffect(codec)(legacy)
  expect([legacy.includes("mentions"), "mentions" in decoded, knowledgeMemoryMentions(decoded)]).toEqual([false, false, [decoded.provenance[0]!.source]])
  const mentioned = { ...memory("mentioned"), mentions: [{ id: KnowledgeSourceId.make("mentioned"), revision: 1 }] }
  expect((yield* Schema.decodeUnknownEffect(codec)(yield* Schema.encodeEffect(codec)(mentioned))).mentions).toEqual(mentioned.mentions)
})))
test("publication refuses a memory that mentions a revision its provenance does not cite", () => {
  const original = memory("one")
  expect(Option.isNone(validateKnowledgeStage(stage({ ...original, mentions: [original.provenance[0]!.source] }), { version: 0, memories: [], graph: emptyGraph }, [source("one")]))).toBe(true)
  expect(Option.isSome(validateKnowledgeStage(stage({ ...original, mentions: [source("two").ref] }), { version: 0, memories: [], graph: emptyGraph }, [source("one"), source("two")]))).toBe(true)
  expect(Option.isSome(validateKnowledgeStage(stage({ ...original, mentions: [{ ...original.provenance[0]!.source, revision: 2 }] }), { version: 0, memories: [], graph: emptyGraph }, [source("one")]))).toBe(true)
})
test("BM25 finds exact tokens and cosine defines zero norms without NaN", () => {
  const scores = knowledgeBm25("ticket-123", ["ticket-123 resolved", "unrelated ticket"])
  expect(scores[0]).toBeGreaterThan(0)
  expect(scores[1]).toBe(0)
  const space = { model: "test", version: "1", dimensions: 2 }
  expect(knowledgeCosine({ space, values: [0, 0] }, { space, values: [1, 0] })).toBe(0)
})
test("cited sources are every revision the evidence cites, once each, candidates first", () => {
  const span = (name: string, revision = 1) => ({ source: { id: KnowledgeSourceId.make(name), revision }, start: 0, end: 4, quote: "Visi" })
  const chunk: KnowledgeCandidate = { _tag: "Chunk", score: 1, chunk: { id: KnowledgeChunkId.make("chunk"), text: "Visi", provenance: span("guide", 2), embedding: Option.none() } }
  const entity = { id: KnowledgeEntityId.make("cafe"), name: "cafe", type: "place", aliases: [], provenance: [span("map"), span("one")] }
  const edge = { id: KnowledgeAssertionId.make("edge"), subject: entity.id, predicate: "near", object: { _tag: "Value" as const, value: "park" }, text: "near", provenance: [span("guide", 1), span("one")], knownFrom: 1, knownTo: Option.none<number>(), validFrom: Option.none<number>(), validTo: Option.none<number>() }
  const cited = citedKnowledgeSources({ candidates: [{ _tag: "Memory", memory: memory("one"), score: 1 }, chunk, chunk], graph: { entities: [entity], assertions: [edge], truncated: false } })
  expect(cited).toEqual([span("one").source, span("guide", 2).source, span("guide", 1).source, span("map").source])
  expect(citedKnowledgeSources({ candidates: [], graph: emptyGraph })).toEqual([])
})
test("a record is dated by the revision its first span cites, and undated when that revision's info is missing", () => {
  const span = (name: string, revision = 1) => ({ source: { id: KnowledgeSourceId.make(name), revision }, start: 0, end: 4, quote: "Visi" })
  const info = (name: string, revision: number, occurredAt: number) => ({ ref: { id: KnowledgeSourceId.make(name), revision }, occurredAt })
  const sources = [info("support", 1, 100), info("own", 2, 300), info("own", 1, 200)]
  expect(knowledgeRecordDate([span("own", 1), span("support")], sources)).toEqual(Option.some(200))
  expect(knowledgeRecordDate([span("own", 2)], sources)).toEqual(Option.some(300))
  // Only the first span dates the record: the evidence after it (entities, supports) never does.
  expect(knowledgeRecordDate([span("forgotten"), span("support")], sources)).toEqual(Option.none())
  expect(knowledgeRecordDate([span("own", 3)], sources)).toEqual(Option.none())
  expect(knowledgeRecordDate([], sources)).toEqual(Option.none())
})
test("a recall result encoded before sources existed decodes with none", async () => {
  const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(KnowledgeRecallResult)({ candidates: [], graph: emptyGraph }))
  expect(decoded.sources).toEqual([])
  const info = { ref: { id: KnowledgeSourceId.make("guide"), revision: 1 }, occurredAt: 1, recordedAt: 2, metadata: { kind: "note", tags: ["a"] } }
  expect((await Effect.runPromise(Schema.decodeUnknownEffect(KnowledgeRecallResult)({ candidates: [], graph: emptyGraph, sources: [info] }))).sources).toEqual([info])
})
test("a failure is retryable unless its reason is final, and always when the optional graph step failed", () => {
  const table: ReadonlyArray<readonly [KnowledgeErrorReason, KnowledgeFailureStep, boolean]> = [
    ["Unavailable", "Required", true], ["Conflict", "Required", true], ["LeaseLost", "Required", true], ["Corrupt", "Required", true],
    ["Invalid", "Required", false], ["Tombstoned", "Required", false], ["EmbeddingMismatch", "Required", false],
    ["Invalid", "Graph", true], ["Unavailable", "Graph", true], ["Tombstoned", "Graph", true],
  ]
  expect(table.map(([reason, step]) => isRetryableKnowledgeFailure({ reason, step }))).toEqual(table.map(([, , retryable]) => retryable))
})
test("a failed job records its reason and step, and one stored before reasons decodes as a transient failure", async () => {
  const stored = { id: "job", scope, source: { id: "source", revision: 1 }, engine: "kit", attempt: 1, stage: null }
  const decode = Schema.decodeUnknownEffect(KnowledgeJob)
  const older = await Effect.runPromise(decode({ ...stored, phase: { _tag: "Failed", message: "the embedding service was unreachable" } }))
  expect(older.phase).toEqual({ _tag: "Failed", reason: "Unavailable", message: "the embedding service was unreachable", step: "Required" })
  expect(older.phase._tag === "Failed" && isRetryableKnowledgeFailure(older.phase)).toBe(true)
  const job: KnowledgeJob = { ...older, id: KnowledgeJobId.make("job"), phase: { _tag: "Failed", reason: "Invalid", message: "the graph extraction was invalid", step: "Graph" } }
  const encoded = await Effect.runPromise(Schema.encodeEffect(KnowledgeJob)(job))
  expect(encoded.phase).toEqual({ _tag: "Failed", reason: "Invalid", message: "the graph extraction was invalid", step: "Graph" })
  expect((await Effect.runPromise(decode(encoded))).phase).toEqual(job.phase)
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

test("a source filter keeps records every span of which cites a listed source", () => {
  const one = KnowledgeSourceId.make("one")
  const two = KnowledgeSourceId.make("two")
  const joint: KnowledgeMemory = { ...memory("joint"), provenance: [...memory("one").provenance, ...memory("two").provenance] }
  expect(citesKnowledgeSources(memory("one").provenance, [one])).toBe(true)
  expect(citesKnowledgeSources(joint.provenance, [one])).toBe(false)
  expect(citesKnowledgeSources(joint.provenance, [one, two])).toBe(true)
  expect(citesKnowledgeSources([], [one])).toBe(false)
  expect(citesKnowledgeSources(memory("one").provenance, [])).toBe(false)
  const chunk: KnowledgeCandidate = { _tag: "Chunk", score: 1, chunk: { id: KnowledgeChunkId.make("chunk"), text: "Visits the", provenance: memory("two").provenance[0]!, embedding: Option.none() } }
  expect([knowledgeCandidateWithin(chunk, [one]), knowledgeCandidateWithin(chunk, [two]), knowledgeCandidateWithin({ _tag: "Memory", score: 1, memory: joint }, [two])]).toEqual([false, true, false])
})

test("a narrowed graph keeps listed spans of mentioned entities and relations wholly from listed sources", () => {
  const spanOf = (name: string) => memory(name).provenance[0]!
  const person = { id: KnowledgeEntityId.make("person"), name: "Person", type: "person", aliases: [], provenance: [spanOf("one"), spanOf("two")] }
  const place = { id: KnowledgeEntityId.make("place"), name: "Cafe", type: "place", aliases: [], provenance: [spanOf("two")] }
  const edge = (name: string, spans: KnowledgeMemory["provenance"], object: "place" | "value") => ({
    id: KnowledgeAssertionId.make(name), subject: person.id, predicate: "visits", text: name, provenance: spans,
    object: object === "place" ? { _tag: "Entity" as const, entityId: place.id } : { _tag: "Value" as const, value: "Monday" },
    validFrom: Option.none<number>(), validTo: Option.none<number>(), knownFrom: 1, knownTo: Option.none<number>(),
  })
  const graph = { entities: [person, place], assertions: [edge("from-one", [spanOf("one")], "value"), edge("from-both", [spanOf("one"), spanOf("two")], "value"), edge("to-place", [spanOf("one")], "place")], truncated: true }
  const narrowed = narrowKnowledgeGraph(graph, [KnowledgeSourceId.make("one")])
  expect(narrowed.entities.map((entity) => [String(entity.id), entity.provenance.map((span) => String(span.source.id))])).toEqual([["person", ["one"]]])
  expect(narrowed.assertions.map((assertion) => String(assertion.id))).toEqual(["from-one"])
  expect(narrowed.truncated).toBe(true)
  expect(narrowKnowledgeGraph(graph, [])).toEqual({ entities: [], assertions: [], truncated: true })
  expect(narrowKnowledgeGraph(graph, [KnowledgeSourceId.make("one"), KnowledgeSourceId.make("two")]).assertions.map((assertion) => String(assertion.id))).toEqual(["from-one", "from-both", "to-place"])
})

test("a metadata filter matches top-level keys by exact value, every key and any alternative", () => {
  const metadata = { kind: "report", pages: 3, draft: false, owner: null, tags: ["a", "b"], nested: { kind: "report" } }
  const cases: ReadonlyArray<readonly [KnowledgeMetadataFilter, boolean]> = [
    [{}, true],
    [{ kind: "report" }, true],
    [{ kind: "Report" }, false],
    [{ kind: ["memo", "report"] }, true],
    [{ kind: [] }, false],
    [{ kind: "report", pages: 3 }, true],
    [{ kind: "report", pages: 4 }, false],
    [{ pages: "3" }, false],
    [{ draft: false }, true],
    [{ draft: 0 }, false],
    [{ owner: null }, true],
    [{ missing: null }, false],
    [{ tags: "a" }, false],
    [{ "nested.kind": "report" }, false],
  ]
  expect(cases.map(([filter]) => matchesKnowledgeMetadata(metadata, filter))).toEqual(cases.map(([, expected]) => expected))
})

test("a metadata filter's schema bounds its keys and alternatives and refuses non-scalar values", () => {
  const decode = Schema.decodeUnknownOption(KnowledgeMetadataFilter)
  expect(Option.isSome(decode({ kind: ["a", 1, true, null] }))).toBe(true)
  expect(Option.isNone(decode({ kind: { nested: "a" } }))).toBe(true)
  expect(Option.isNone(decode({ kind: [["a"]] }))).toBe(true)
  expect(Option.isNone(decode({ pages: Number.POSITIVE_INFINITY }))).toBe(true)
  expect(Option.isSome(decode(Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`key-${index}`, index]))))).toBe(true)
  expect(Option.isNone(decode(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key-${index}`, index]))))).toBe(true)
  expect(Option.isNone(decode({ kind: Array.from({ length: 101 }, (_, index) => index) }))).toBe(true)
  // Search, recall and reach take it beside `sources`; a search without it decodes unchanged.
  const search = { scope, query: "q", vector: null, limit: 1, knownAt: null }
  expect(Option.map(Schema.decodeUnknownOption(KnowledgeSearch)(search), (value) => "metadata" in value)).toEqual(Option.some(false))
  expect(Option.isSome(Schema.decodeUnknownOption(KnowledgeSearch)({ ...search, metadata: { kind: "report" } }))).toBe(true)
})

test("a narrowing admits a cited revision when both its source list and its metadata filter hold for that revision", () => {
  const info = (name: string, revision: number, metadata: KnowledgeSource["metadata"]) => ({ ref: { id: KnowledgeSourceId.make(name), revision }, metadata })
  const infos = [info("one", 1, { kind: "report" }), info("one", 2, { kind: "memo" }), info("two", 1, { kind: "report" })]
  const refOf = (name: string, revision: number) => ({ id: KnowledgeSourceId.make(name), revision })
  const byMetadata = knowledgeNarrowingAdmits({ metadata: { kind: "report" } }, infos)
  // The revision a span cites decides, and a revision without info (forgotten or unknown) matches no filter.
  expect([byMetadata(refOf("one", 1)), byMetadata(refOf("one", 2)), byMetadata(refOf("two", 1)), byMetadata(refOf("three", 1))]).toEqual([true, false, true, false])
  const both = knowledgeNarrowingAdmits({ metadata: { kind: "report" }, sources: [KnowledgeSourceId.make("two")] }, infos)
  expect([both(refOf("one", 1)), both(refOf("two", 1))]).toEqual([false, true])
  // Without a metadata filter, the source list alone decides, as it always has; without either, everything is admitted.
  expect(knowledgeNarrowingAdmits({ sources: [KnowledgeSourceId.make("three")] }, [])(refOf("three", 1))).toBe(true)
  expect(knowledgeNarrowingAdmits({}, [])(refOf("three", 1))).toBe(true)
  expect([admitsKnowledgeSource({ metadata: { kind: "memo" } }, infos[1]!), admitsKnowledgeSource({ metadata: { kind: "memo" } }, infos[0]!)]).toEqual([true, false])
  const joint: KnowledgeMemory = { ...memory("joint"), provenance: [...memory("one").provenance, ...memory("two").provenance] }
  expect([citesAdmittedKnowledge(joint.provenance, byMetadata), citesAdmittedKnowledge(joint.provenance, both), citesAdmittedKnowledge([], byMetadata)]).toEqual([true, false, false])
  const chunk: KnowledgeCandidate = { _tag: "Chunk", score: 1, chunk: { id: KnowledgeChunkId.make("chunk"), text: "Visits the", provenance: memory("two").provenance[0]!, embedding: Option.none() } }
  expect([knowledgeCandidateAdmitted(chunk, both), knowledgeCandidateAdmitted({ _tag: "Memory", score: 1, memory: joint }, both)]).toEqual([true, false])
})

test("a graph narrowed by a predicate keeps admitted spans and wholly admitted relations, as the source-list form does", () => {
  const spanOf = (name: string) => memory(name).provenance[0]!
  const person = { id: KnowledgeEntityId.make("person"), name: "Person", type: "person", aliases: [], provenance: [spanOf("one"), spanOf("two")] }
  const edge = (name: string, spans: KnowledgeMemory["provenance"]) => ({
    id: KnowledgeAssertionId.make(name), subject: person.id, predicate: "visits", text: name, provenance: spans, object: { _tag: "Value" as const, value: "Monday" },
    validFrom: Option.none<number>(), validTo: Option.none<number>(), knownFrom: 1, knownTo: Option.none<number>(),
  })
  const graph = { entities: [person], assertions: [edge("from-one", [spanOf("one")]), edge("from-both", [spanOf("one"), spanOf("two")])], truncated: false }
  const admits = knowledgeNarrowingAdmits({ metadata: { kind: "report" } }, [{ ref: spanOf("one").source, metadata: { kind: "report" } }, { ref: spanOf("two").source, metadata: { kind: "memo" } }])
  expect(narrowKnowledgeGraphBy(graph, admits)).toEqual(narrowKnowledgeGraph(graph, [KnowledgeSourceId.make("one")]))
  expect(narrowKnowledgeGraphBy(graph, () => false)).toEqual({ entities: [], assertions: [], truncated: false })
})

test("a job stored with only graph notes and assertions without a validity basis decodes unchanged, and dropped-record notes round-trip", () => Effect.runPromise(Effect.gen(function* () {
  const assertion = {
    id: "edge", subject: "ann", predicate: "lives_in", object: { _tag: "Value", value: "Oslo" }, text: "Ann lives in Oslo.",
    provenance: [{ source: { id: "note", revision: 1 }, start: 0, end: 3, quote: "Ann" }], validFrom: 10, validTo: null, knownFrom: 20, knownTo: null,
  }
  const stored = {
    id: "job", scope, source: { id: "note", revision: 1 }, engine: "memory:1/host/1/2", attempt: 1, phase: { _tag: "Complete", publishedAt: 30 },
    stage: { expectedVersion: 0, memories: [], chunks: [], entities: [], assertions: [assertion], retireMemories: [], retireAssertions: [], notes: [{ _tag: "GraphOmitted", reason: "Invalid", message: "graph left out" }] },
  }
  const legacy = yield* Schema.decodeUnknownEffect(KnowledgeJob)(stored)
  expect(Option.map(legacy.stage, (value) => [value.notes, value.assertions[0]?.validFromBasis])).toEqual(Option.some([[{ _tag: "GraphOmitted", reason: "Invalid", message: "graph left out" }], undefined]))
  expect<unknown>(yield* Schema.encodeEffect(KnowledgeJob)(legacy)).toEqual(stored)
  const current = { ...stored, stage: { ...stored.stage, assertions: [{ ...assertion, validFromBasis: "observed" }], notes: [...stored.stage.notes, { _tag: "RecordDropped", record: "assertion", key: "moved", reason: "Invalid", message: "The extraction refers to an undefined entity key" }] } }
  expect<unknown>(yield* Schema.encodeEffect(KnowledgeJob)(yield* Schema.decodeUnknownEffect(KnowledgeJob)(current))).toEqual(current)
  expect((yield* Effect.result(Schema.decodeUnknownEffect(KnowledgeJob)({ ...current, stage: { ...current.stage, notes: [{ _tag: "RecordDropped", record: "chunk", key: "x", reason: "Invalid", message: "" }] } })))._tag).toBe("Failure")
})))

test("a corroboration appends its revision's spans and mention once, and a later revision strips them without emptying the memory", () => {
  const owner = memory("owner")
  const restating = source("restating")
  const corroboration = { memory: owner.id, mention: restating.ref, provenance: [{ source: restating.ref, start: 11, end: 15, quote: "cafe" }] }
  // A memory stored before mentions existed gains them, starting with the revision its first span cites.
  const corroborated = corroborateKnowledgeMemory(corroborateKnowledgeMemory(owner, corroboration), corroboration)
  expect([corroborated.provenance.length, corroborated.mentions]).toEqual([2, [source("owner").ref, restating.ref]])
  expect(knowledgeMemorySupport(corroborated, [source("owner"), restating].map((value) => ({ ref: value.ref, occurredAt: value.occurredAt, metadata: {} })))).toEqual(Option.some({ episodes: 2, sources: 2, firstSeen: 1, lastSeen: 1 }))
  // The restating source's second revision takes its first revision's evidence away; its own revision stays.
  const later = { ...restating.ref, revision: 2 }
  const again = corroborateKnowledgeMemory(corroborated, { ...corroboration, mention: later, provenance: [{ ...corroboration.provenance[0]!, source: later }] })
  expect(Option.map(stripKnowledgeRevisions(again, later), (value) => [value.provenance.map((span) => span.source), value.mentions])).toEqual(Option.some([[owner.provenance[0]!.source, later], [owner.provenance[0]!.source, later]]))
  expect(stripKnowledgeRevisions(owner, later)).toEqual(Option.some(owner))
  // Nothing of the memory left: none, and the store retires it instead.
  expect(stripKnowledgeRevisions(owner, { ...owner.provenance[0]!.source, revision: 2 })).toEqual(Option.none())
})

test("a narrowed read keeps a memory restated from outside it, without the restatement's evidence, and never shows it from the restatement alone", () => {
  const owner = memory("owner")
  const restating = source("restating")
  const corroborated = corroborateKnowledgeMemory(owner, { memory: owner.id, mention: restating.ref, provenance: [{ source: restating.ref, start: 11, end: 15, quote: "cafe" }] })
  const within = (ids: ReadonlyArray<string>) => (ref: { readonly id: string }) => ids.includes(ref.id)
  expect(narrowKnowledgeMemory(corroborated, within(["owner", "restating"]))).toEqual(Option.some(corroborated))
  expect(narrowKnowledgeMemory(corroborated, within(["owner"]))).toEqual(Option.some({ ...corroborated, provenance: owner.provenance, mentions: [source("owner").ref] }))
  expect([narrowKnowledgeMemory(corroborated, within(["restating"])), narrowKnowledgeMemory(owner, within(["restating"]))]).toEqual([Option.none(), Option.none()])
  // Evidence of the memory's own that cites another source (its entities') still has to be admitted; an inference's mentions are all its own.
  const withEntity = { ...corroborated, provenance: [...owner.provenance, { source: source("entity").ref, start: 0, end: 6, quote: "Visits" }, ...corroborated.provenance.slice(1)] }
  expect([narrowKnowledgeMemory(withEntity, within(["owner"])), Option.isSome(narrowKnowledgeMemory(withEntity, within(["owner", "entity"])))]).toEqual([Option.none(), true])
  const inferred = { ...corroborated, evidence: { _tag: "Inferred" as const, supports: [KnowledgeMemoryId.make("support")] } }
  expect(narrowKnowledgeMemory(inferred, within(["owner"]))).toEqual(Option.none())
  expect([knowledgeCandidateWithin({ _tag: "Memory", score: 1, memory: corroborated }, [KnowledgeSourceId.make("owner")]), knowledgeCandidateAdmitted({ _tag: "Memory", score: 1, memory: corroborated }, within(["restating"]))]).toEqual([true, false])
})

test("a stage corroborates only an active stated memory of the snapshot, with spans of its own revision", () => {
  const target = memory("target")
  const restating = source("restating")
  const corroboration: KnowledgeCorroboration = { memory: target.id, mention: restating.ref, provenance: [{ source: restating.ref, start: 0, end: 6, quote: "Visits" }] }
  const only = (corroborations: ReadonlyArray<KnowledgeCorroboration>, retire: ReadonlyArray<KnowledgeMemory["id"]> = []): KnowledgeStage => ({ ...stage(memory("restating")), memories: [], corroborations, retireMemories: retire })
  const snapshot = (memories: ReadonlyArray<KnowledgeMemory>) => ({ version: 0, memories, graph: emptyGraph })
  const sources = [source("target"), restating]
  const reason = (found: Option.Option<{ readonly reason: KnowledgeErrorReason }>) => Option.map(found, (failure) => failure.reason)
  expect(validateKnowledgeStage(only([corroboration]), snapshot([target]), sources)).toEqual(Option.none())
  expect(reason(validateKnowledgeStage(only([corroboration]), snapshot([{ ...target, knownTo: Option.some(3) }]), sources))).toEqual(Option.some("Conflict"))
  expect(reason(validateKnowledgeStage(only([corroboration]), snapshot([]), sources))).toEqual(Option.some("Conflict"))
  expect(reason(validateKnowledgeStage(only([corroboration], [target.id]), snapshot([target]), sources))).toEqual(Option.some("Conflict"))
  expect(reason(validateKnowledgeStage(only([{ ...corroboration, provenance: target.provenance }]), snapshot([target]), sources))).toEqual(Option.some("Invalid"))
  expect(reason(validateKnowledgeStage(only([corroboration]), snapshot([{ ...target, evidence: { _tag: "Inferred", supports: [KnowledgeMemoryId.make("other")] } }]), sources))).toEqual(Option.some("Invalid"))
  expect(reason(validateKnowledgeStage(only([{ ...corroboration, provenance: [{ ...corroboration.provenance[0]!, quote: "invented" }] }]), snapshot([target]), sources))).toEqual(Option.some("Invalid"))
})
test("a goal, decision, action or preference is past once its dated event ended; a fact, routine or profile never is", () => {
  const opening = Date.UTC(2026, 2, 20, 10), closing = Date.UTC(2026, 2, 24, 18)
  const dated = (kind: KnowledgeMemory["kind"], eventAt?: KnowledgeMemory["eventAt"]): KnowledgeMemory => ({ ...memory(kind), kind, ...(eventAt === undefined ? {} : { eventAt }) })
  const kinds: ReadonlyArray<KnowledgeMemory["kind"]> = ["goal", "decision", "action", "preference", "fact", "routine", "profile"]
  // After the event, only the kinds tied to it are past.
  expect(kinds.map((kind) => knowledgeMemoryIsPast(dated(kind, { start: opening }), opening + 1))).toEqual([true, true, true, true, false, false, false])
  // Up to its time, never: the event ends strictly before now.
  expect(kinds.map((kind) => knowledgeMemoryIsPast(dated(kind, { start: opening }), opening))).toEqual(kinds.map(() => false))
  // An event with an end holds until the end, not the start.
  expect([closing - 1, closing, closing + 1].map((now) => knowledgeMemoryIsPast(dated("goal", { start: opening, end: closing }), now))).toEqual([false, false, true])
  // A memory without an event, as every one stored before events existed, is never past.
  expect(kinds.map((kind) => knowledgeMemoryIsPast(dated(kind), Number.MAX_SAFE_INTEGER))).toEqual(kinds.map(() => false))
})
test("a stored memory decodes with or without an event time, and an event that ends before it starts is refused", () => {
  const encoded = Schema.encodeSync(KnowledgeMemoryCodec)(memory("legacy"))
  expect("eventAt" in Schema.decodeUnknownSync(KnowledgeMemoryCodec)(encoded)).toBe(false)
  expect(Schema.decodeUnknownSync(KnowledgeMemoryCodec)({ ...encoded, eventAt: { start: 5, end: 9 } }).eventAt).toEqual({ start: 5, end: 9 })
  expect(Schema.decodeUnknownSync(KnowledgeMemoryCodec)({ ...encoded, eventAt: { start: 5 } }).eventAt).toEqual({ start: 5 })
  expect(Schema.decodeUnknownExit(KnowledgeMemoryCodec)({ ...encoded, eventAt: { start: 9, end: 5 } })._tag).toBe("Failure")
})
