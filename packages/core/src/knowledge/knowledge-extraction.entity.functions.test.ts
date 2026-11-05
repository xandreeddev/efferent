import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref, Schema } from "effect"
import {
  KnowledgeAssertionId, KnowledgeEntityId, KnowledgeMemoryId, KnowledgeSourceId,
} from "./knowledge.entity.js"
import type { KnowledgeSnapshot, KnowledgeSource } from "./knowledge.entity.js"
import { KnowledgeExtraction } from "./knowledge-extraction.entity.js"
import { KNOWLEDGE_EXTRACTION_VERSION, extractKnowledge, extractionCandidateContext, knowledgeExtractionPrompt, knowledgeExtractionWindows, knowledgeReviewPrompt, stageKnowledgeExtraction } from "./knowledge-extraction.entity.functions.js"
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
    expect(knowledgeExtractionPrompt({ ...source, text: "A note.\n\nA second note." }, empty, "document", 1000, true, { part: 2, parts: 2, start: 9, end: 23 })).toBe(await Bun.file(new URL("../../golden/knowledge-extraction-part.prompt.txt", import.meta.url)).text())
    expect(knowledgeExtractionPrompt(source, empty, "memory", 1000, true, { part: 1, parts: 1, start: 0, end: source.text.length })).toBe(prompt)
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

  test("literal evidence repairs offset errors at the nearest occurrence while invented quotes are rejected", () => Effect.runPromise(Effect.gen(function* () {
    const repaired = yield* Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...plain, memories: [{ ...plain.memories[0]!, spans: [{ start: 1, end: 2, quote: "A note." }] }] })
    expect((yield* stageKnowledgeExtraction(source, empty, repaired, 30)).memories[0]?.provenance[0]).toEqual({ source: source.ref, start: 0, end: 7, quote: "A note." })
    const repeated = { ...source, text: "A note and another note." }
    const near = (start: number) => Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...plain, memories: [{ ...plain.memories[0]!, spans: [{ start, end: start + 1, quote: "note" }] }] })
    expect((yield* stageKnowledgeExtraction(repeated, empty, yield* near(4), 30)).memories[0]?.provenance[0]).toEqual({ source: source.ref, start: 2, end: 6, quote: "note" })
    expect((yield* stageKnowledgeExtraction(repeated, empty, yield* near(17), 30)).memories[0]?.provenance[0]).toEqual({ source: source.ref, start: 19, end: 23, quote: "note" })
    const invented = yield* Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...plain, memories: [{ ...plain.memories[0]!, spans: [{ start: 2, end: 6, quote: "nothing" }] }] })
    expect((yield* stageKnowledgeExtraction(repeated, empty, invented, 30).pipe(Effect.result))._tag).toBe("Failure")
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

const filler = (word: string, count: number) => Array.from({ length: count }, (_, index) => `${word} ${index}.`).join(" ")
/** Three paragraphs, each naming Atlas once, with Ada in the first and last: about 2,100 characters. */
const longText = [`Ada leads Atlas. ${filler("Planning", 60)}`, `Atlas moved to the north site. ${filler("Logistics", 55)}`, `Ada reviewed Atlas again. ${filler("Review", 70)}`].join("\n\n")
const longSource: KnowledgeSource = { ...source, ref: { id: KnowledgeSourceId.make("long"), revision: 1 }, text: longText }
const sourceFrame = (prompt: string) => /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
/** An extractor that names Atlas, and Ada where the part mentions her, at offsets within the part it reads. */
const windowExtractor = (part: string) => ({
  entities: [
    { key: "atlas", name: "Atlas", type: "project", aliases: [], existing: null, spans: [{ start: part.indexOf("Atlas"), end: part.indexOf("Atlas") + 5, quote: "Atlas" }] },
    ...(part.includes("Ada") ? [{ key: "ada", name: "Ada", type: "person", aliases: [], existing: null, spans: [{ start: part.indexOf("Ada"), end: part.indexOf("Ada") + 3, quote: "Ada" }] }] : []),
  ],
  memories: [],
  assertions: [{ key: "mention", subject: "atlas", predicate: "mentioned", object: { _tag: "Value", value: true }, text: "Atlas is mentioned.", spans: [{ start: part.indexOf("Atlas"), end: part.indexOf("Atlas") + 5, quote: "Atlas" }], validFrom: null, validTo: null, supersedes: [], supersession: "correction" }],
})

describe("bounded extraction windows", () => {
  test("windows cover the text in order within the bound, cut at paragraphs and never split a surrogate pair", () => {
    const windows = knowledgeExtractionWindows(longText, 1_000)
    expect(windows.length).toBeGreaterThan(2)
    expect(windows.map((window) => [window.part, window.parts])).toEqual(windows.map((_, index) => [index + 1, windows.length]))
    expect(windows[0]?.start).toBe(0)
    expect(windows.at(-1)?.end).toBe(longText.length)
    expect(windows.every((window, index) => window.end - window.start <= 1_000 && window.end > window.start && (index === 0 || windows[index - 1]?.end === window.start))).toBe(true)
    expect(windows.slice(0, -1).every((window) => longText.slice(window.end - 2, window.end) === "\n\n" || longText.charAt(window.end - 1) === " ")).toBe(true)
    expect(knowledgeExtractionWindows("short", 1_000)).toEqual([{ part: 1, parts: 1, start: 0, end: 5 }])
    expect(knowledgeExtractionWindows("", 1_000)).toEqual([{ part: 1, parts: 1, start: 0, end: 0 }])
    const emoji = "🙂".repeat(1_500)
    const pairs = knowledgeExtractionWindows(emoji, 1_001)
    expect(pairs.every((window) => window.end - window.start <= 1_001 && (window.end - window.start) % 2 === 0)).toBe(true)
    expect(pairs.map((window) => emoji.slice(window.start, window.end)).join("")).toBe(emoji)
  })

  test("a long source makes one bounded call per window and merges exact whole-source provenance", () => Effect.runPromise(Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<{ readonly purpose: string; readonly part: string }>>([])
    const merged = yield* extractKnowledge({
      source: longSource, snapshot: empty, mode: "document", maxContextChars: 1_000, maxExtractionChars: 1_000, consolidate: true, review: true,
      complete: (prompt, purpose) => Ref.update(calls, (all) => [...all, { purpose, part: sourceFrame(prompt) }]).pipe(
        Effect.andThen(Schema.decodeUnknownEffect(KnowledgeExtraction)(windowExtractor(sourceFrame(prompt)))), Effect.orDie,
      ),
    })
    const windows = knowledgeExtractionWindows(longText, 1_000)
    const seen = yield* Ref.get(calls)
    expect(seen.map((call) => call.purpose)).toEqual(windows.flatMap(() => ["extract", "review"]))
    expect(seen.filter((call) => call.purpose === "extract").map((call) => call.part)).toEqual(windows.map((window) => longText.slice(window.start, window.end)))
    expect(seen.every((call) => call.part.length > 0 && call.part.length <= 1_000)).toBe(true)
    expect(merged.entities.map((entity) => entity.key)).toEqual(["atlas", "ada"])
    expect(merged.assertions.map((assertion) => assertion.key)).toEqual(["mention", ...windows.slice(1).map((window) => `mention~${window.part}`)])
    const stage = yield* stageKnowledgeExtraction(longSource, empty, merged, 30)
    const atlas = stage.entities.find((entity) => entity.name === "Atlas")
    expect(atlas?.provenance.map((span) => span.start)).toEqual(windows.map((window) => window.start + longText.slice(window.start, window.end).indexOf("Atlas")))
    expect(stage.entities.flatMap((entity) => entity.provenance).every((span) => longText.slice(span.start, span.end) === span.quote)).toBe(true)
    expect(stage.assertions.flatMap((assertion) => assertion.provenance).every((span) => longText.slice(span.start, span.end) === span.quote)).toBe(true)
  })))

  test("a source that fits one window makes the whole-source calls and keeps their result", () => Effect.runPromise(Effect.gen(function* () {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([])
    const decoded = yield* extraction
    const result = yield* extractKnowledge({
      source, snapshot: empty, mode: "memory", maxContextChars: 1000, maxExtractionChars: 1_000, consolidate: true, review: false,
      complete: (prompt) => Ref.update(prompts, (all) => [...all, prompt]).pipe(Effect.as(decoded)),
    })
    expect(result).toBe(decoded)
    expect(yield* Ref.get(prompts)).toEqual([knowledgeExtractionPrompt(source, empty, "memory", 1000)])
  })))

  test("a window's offsets are repaired within that window, and a conflicting identity keeps its own key", () => Effect.runPromise(Effect.gen(function* () {
    const windows = knowledgeExtractionWindows(longText, 1_000)
    const merged = yield* extractKnowledge({
      source: longSource, snapshot: { ...empty, graph: { ...empty.graph, entities: [
        { id: KnowledgeEntityId.make("known-a"), name: "Atlas", type: "project", aliases: [], provenance: [] },
        { id: KnowledgeEntityId.make("known-b"), name: "Atlas", type: "project", aliases: [], provenance: [] },
      ] } }, mode: "document", maxContextChars: 1_000, maxExtractionChars: 1_000, consolidate: true, review: false,
      complete: (prompt) => {
        const part = sourceFrame(prompt)
        const value = windowExtractor(part)
        const first = part === longText.slice(0, windows[0]!.end)
        return Schema.decodeUnknownEffect(KnowledgeExtraction)({
          ...value,
          entities: value.entities.map((entity) => entity.key === "atlas" ? { ...entity, existing: first ? "known-a" : "known-b", spans: [{ start: 0, end: 5, quote: "Atlas" }] } : entity),
          assertions: value.assertions.map((assertion) => ({ ...assertion, spans: [{ start: 1, end: 6, quote: "Atlas" }] })),
        }).pipe(Effect.orDie)
      },
    })
    expect(merged.entities.map((entity) => [entity.key, Option.getOrElse(entity.existing, () => "")])).toEqual([["atlas", "known-a"], ["ada", ""], ["atlas~2", "known-b"]])
    expect(merged.assertions.map((assertion) => assertion.subject)).toEqual(["atlas", ...windows.slice(1).map(() => "atlas~2")])
    expect(merged.entities.flatMap((entity) => entity.spans).every((span) => longText.slice(span.start, span.end) === span.quote)).toBe(true)
    expect(merged.assertions.flatMap((assertion) => assertion.spans).map((span) => span.start)).toEqual(windows.map((window) => window.start + longText.slice(window.start, window.end).indexOf("Atlas")))
  })))

  test("a window that names an undefined entity key is refused before anything is merged", () => Effect.runPromise(Effect.gen(function* () {
    const result = yield* extractKnowledge({
      source: longSource, snapshot: empty, mode: "document", maxContextChars: 1_000, maxExtractionChars: 1_000, consolidate: true, review: false,
      complete: (prompt) => Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...windowExtractor(sourceFrame(prompt)), entities: [] }).pipe(Effect.orDie),
    }).pipe(Effect.result)
    expect(result._tag === "Failure" && result.failure.reason).toBe("Invalid")
  })))
})
