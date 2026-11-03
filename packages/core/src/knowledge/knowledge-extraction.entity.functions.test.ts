import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import {
  KnowledgeAssertionId, KnowledgeEntityId, KnowledgeMemoryId, KnowledgeSourceId,
} from "./knowledge.entity.js"
import type { KnowledgeSnapshot, KnowledgeSource } from "./knowledge.entity.js"
import { KnowledgeExtraction } from "./knowledge-extraction.entity.js"
import { KNOWLEDGE_EXTRACTION_VERSION, extractionCandidateContext, knowledgeExtractionPrompt, knowledgeReviewPrompt, stageKnowledgeExtraction } from "./knowledge-extraction.entity.functions.js"
import { KnowledgeQueryPlan, KnowledgeRerank } from "./knowledge-query.entity.js"
import { applyKnowledgeRerank, budgetKnowledgeRecall, knowledgeQueryPrompt, knowledgeRerankPrompt } from "./knowledge-query.entity.functions.js"

const source: KnowledgeSource = { scope: { owner: "fixture", namespace: "fixture", collection: "memory" }, ref: { id: KnowledgeSourceId.make("note"), revision: 1 }, text: "A note.", occurredAt: 10, recordedAt: 20, metadata: {} }
const empty: KnowledgeSnapshot = { version: 0, memories: [], graph: { entities: [], assertions: [], truncated: false } }
const plain = {
  entities: [{ key: "a", name: "A", type: "person", aliases: [], existing: null, spans: [{ start: 0, end: 1, quote: "A" }] }],
  memories: [{ key: "note", kind: "fact", text: "A note.", entities: ["a"], spans: [{ start: 0, end: 7, quote: "A note." }], evidence: { _tag: "Stated" }, supersedes: [] }], assertions: [],
}
const extraction = Schema.decodeUnknownEffect(KnowledgeExtraction)(plain)

describe("native extraction and retrieval contracts", () => {
  test("extraction, review, query and rerank prompts are pinned in full", async () => {
    const decoded = await Effect.runPromise(extraction)
    const prompt = knowledgeExtractionPrompt(source, empty, "memory", 1000)
    expect(KNOWLEDGE_EXTRACTION_VERSION).toBe("1")
    expect(prompt).toBe(await Bun.file(new URL("../../golden/knowledge-extraction.prompt.txt", import.meta.url)).text())
    expect(knowledgeExtractionPrompt(source, empty, "document", 1000)).toBe(await Bun.file(new URL("../../golden/knowledge-document.prompt.txt", import.meta.url)).text())
    expect(knowledgeReviewPrompt(prompt, decoded)).toBe(await Bun.file(new URL("../../golden/knowledge-review.prompt.txt", import.meta.url)).text())
    expect(knowledgeQueryPrompt("Who works on Atlas?", 100)).toBe(await Bun.file(new URL("../../golden/knowledge-query.prompt.txt", import.meta.url)).text())
    expect(knowledgeRerankPrompt("Who?", [], empty.graph, 1000)).toBe(await Bun.file(new URL("../../golden/knowledge-rerank.prompt.txt", import.meta.url)).text())
  })

  test("decoded extraction becomes a grounded stage and carries entity attribution evidence", () => Effect.runPromise(Effect.gen(function* () {
    const stage = yield* stageKnowledgeExtraction(source, empty, yield* extraction, 30)
    expect(stage.expectedVersion).toBe(0)
    expect(stage.entities[0]?.provenance).toEqual([{ source: source.ref, start: 0, end: 1, quote: "A" }])
    expect(stage.memories[0]?.provenance).toEqual([{ source: source.ref, start: 0, end: 7, quote: "A note." }, { source: source.ref, start: 0, end: 1, quote: "A" }])
    expect(stage.memories[0]?.embedding).toEqual(Option.none())
  })))

  test("unknown identities, unsupported supersession and invalid source spans change nothing", () => Effect.runPromise(Effect.gen(function* () {
    const cases = [
      { ...plain, entities: [{ ...plain.entities[0]!, existing: KnowledgeEntityId.make("other-owner") }] },
      { ...plain, memories: [{ ...plain.memories[0]!, supersedes: [KnowledgeMemoryId.make("unknown")] }] },
      { ...plain, memories: [{ ...plain.memories[0]!, spans: [{ start: 0, end: 100, quote: "invented quotation" }] }] },
    ]
    yield* Effect.forEach(cases, (value) => Schema.decodeUnknownEffect(KnowledgeExtraction)(value).pipe(
      Effect.flatMap((decoded) => stageKnowledgeExtraction(source, empty, decoded, 30)), Effect.result,
      Effect.map((result) => expect(result._tag).toBe("Failure")),
    ), { concurrency: 1 })
  })))

  test("unique literal evidence repairs offset errors while invented or ambiguous quotes are rejected", () => Effect.runPromise(Effect.gen(function* () {
    const repaired = yield* Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...plain, memories: [{ ...plain.memories[0]!, spans: [{ start: 1, end: 2, quote: "A note." }] }] })
    expect((yield* stageKnowledgeExtraction(source, empty, repaired, 30)).memories[0]?.provenance[0]).toEqual({ source: source.ref, start: 0, end: 7, quote: "A note." })
    const ambiguous = yield* Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...plain, memories: [{ ...plain.memories[0]!, spans: [{ start: 2, end: 3, quote: "note" }] }] })
    expect((yield* stageKnowledgeExtraction({ ...source, text: "A note and another note." }, empty, ambiguous, 30).pipe(Effect.result))._tag).toBe("Failure")
    expect((yield* Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...plain, memories: [{ ...plain.memories[0]!, spans: [{ start: 0, end: 7 }] }] }).pipe(Effect.result))._tag).toBe("Failure")
  })))

  test("candidate context keeps relevant whole records after a large entity catalogue", () => Effect.runPromise(Effect.gen(function* () {
    const stage = yield* stageKnowledgeExtraction(source, empty, yield* extraction, 30)
    const target = { ...stage.memories[0]!, text: "Atlas deployment uses the blue lane." }
    const noisy = Array.from({ length: 120 }, (_, index) => ({ ...stage.entities[0]!, id: KnowledgeEntityId.make(`noise-${index}`), name: `Unrelated entity ${index}` }))
    const snapshot = { ...empty, memories: [target], graph: { ...empty.graph, entities: noisy } }
    const text = extractionCandidateContext({ ...source, text: "Change Atlas deployment to the green lane." }, snapshot, 2_000)
    expect(text.length).toBeLessThanOrEqual(2_000)
    const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Struct({ memories: Schema.Array(Schema.Struct({ text: Schema.String })) })))(text)
    expect(decoded._tag === "Success" && decoded.success.memories.map((memory) => memory.text)).toEqual([target.text])
  })))

  test("candidate and graph evidence share one budget without cutting source references", () => Effect.runPromise(Effect.gen(function* () {
    const stage = yield* stageKnowledgeExtraction(source, empty, yield* extraction, 30)
    const assertions = Array.from({ length: 20 }, (_, index) => ({
      id: KnowledgeAssertionId.make(`edge-${index}`), subject: stage.entities[0]!.id, predicate: "describes", object: { _tag: "Value" as const, value: "note" },
      text: `Grounded relationship ${index}.`, provenance: stage.memories[0]!.provenance,
      validFrom: Option.none<number>(), validTo: Option.none<number>(), knownFrom: 30, knownTo: Option.none<number>(),
    }))
    const result = budgetKnowledgeRecall({ candidates: [{ _tag: "Memory", memory: stage.memories[0]!, score: 1 }], graph: { entities: stage.entities, assertions, truncated: false } }, 600, 8)
    expect(result.graph.truncated).toBe(true)
    expect(result.graph.assertions.length).toBeGreaterThan(0)
    expect(result.graph.assertions.length).toBeLessThan(20)
    expect(result.candidates).toHaveLength(1)
    expect(result.graph.assertions.every((assertion) => assertion.provenance[0]?.source.id === source.ref.id)).toBe(true)
  })))

  test("model protocols reject malformed plans and reranks reject invented or repeated keys", () => Effect.runPromise(Effect.gen(function* () {
    expect((yield* Schema.decodeUnknownEffect(Schema.fromJsonString(KnowledgeQueryPlan))('{"queries":[],"entities":[],"validAt":null,"knownAt":null}').pipe(Effect.result))._tag).toBe("Failure")
    const decoded = yield* Schema.decodeUnknownEffect(KnowledgeRerank)({ order: ["unknown"] })
    expect(applyKnowledgeRerank([], decoded)).toEqual(Option.none())
    expect(applyKnowledgeRerank([], { order: [] })).toEqual(Option.some([]))
  })))
})
