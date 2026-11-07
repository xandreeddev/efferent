import { describe, expect, test } from "bun:test"
import { Effect, Match, Option, Ref, Schema } from "effect"
import {
  KnowledgeAssertionId, KnowledgeEntityId, KnowledgeMemory, KnowledgeMemoryId, KnowledgeRecallResult, KnowledgeSourceId,
} from "./knowledge.entity.js"
import type { KnowledgeSnapshot, KnowledgeSource } from "./knowledge.entity.js"
import { KnowledgeExtraction } from "./knowledge-extraction.entity.js"
import { knowledgeRecordDate } from "./knowledge.entity.functions.js"
import { KNOWLEDGE_EXTRACTION_VERSION, extractKnowledge, extractionCandidateContext, knowledgeExtractionPrompt, knowledgeExtractionWindows, knowledgeReviewPrompt, stageKnowledgeExtraction } from "./knowledge-extraction.entity.functions.js"
import { KnowledgeQueryPlan, KnowledgeRerank } from "./knowledge-query.entity.js"
import { applyKnowledgeRerank, budgetKnowledgeRecall, knowledgeQueryPrompt, knowledgeRerankPrompt } from "./knowledge-query.entity.functions.js"

const source: KnowledgeSource = { scope: { owner: "fixture", namespace: "fixture", collection: "memory" }, ref: { id: KnowledgeSourceId.make("note"), revision: 1 }, text: "A note.", occurredAt: 10, recordedAt: 20, metadata: {} }
const empty: KnowledgeSnapshot = { version: 0, memories: [], graph: { entities: [], assertions: [], truncated: false } }
const plain = {
  entities: [{ key: "a", name: "A", type: "person", aliases: [], existing: null, spans: [{ start: 0, end: 1, quote: "A" }] }],
  memories: [{ key: "note", kind: "fact", text: "A note.", entities: ["a"], spans: [{ start: 0, end: 7, quote: "A note." }], evidence: { _tag: "Stated" }, supersedes: [], supersession: "change" }], assertions: [],
}
const extraction = Schema.decodeUnknownEffect(KnowledgeExtraction)(plain)

describe("native extraction and retrieval contracts", () => {
  test("extraction, review, query and rerank prompts are pinned in full", async () => {
    const decoded = await Effect.runPromise(extraction)
    const prompt = knowledgeExtractionPrompt(source, empty, "memory", 1000)
    expect(KNOWLEDGE_EXTRACTION_VERSION).toBe("3")
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

  test("an extraction whose every record fails its own checks changes nothing", () => Effect.runPromise(Effect.gen(function* () {
    const cases = [
      { ...plain, entities: [{ ...plain.entities[0]!, existing: KnowledgeEntityId.make("other-owner") }] },
      { entities: [], memories: [{ ...plain.memories[0]!, entities: [], supersedes: [KnowledgeMemoryId.make("unknown")] }], assertions: [] },
      { entities: [], memories: [{ ...plain.memories[0]!, entities: [], spans: [{ start: 0, end: 100, quote: "invented quotation" }] }], assertions: [] },
    ]
    const results = yield* Effect.forEach(cases, (value) => Schema.decodeUnknownEffect(KnowledgeExtraction)(value).pipe(
      Effect.orDie, Effect.flatMap((decoded) => stageKnowledgeExtraction(source, empty, decoded, 30)), Effect.flip,
      Effect.map((error) => [error.reason, error.message]),
    ), { concurrency: 1 })
    expect(results).toEqual([
      ["Invalid", "The extraction names an unknown entity"],
      ["Invalid", "The extraction retires an unknown or inactive record"],
      ["Invalid", "The extraction cites an invalid source span"],
    ])
  })))

  test("literal evidence repairs offset errors at the nearest occurrence while invented quotes are rejected", () => Effect.runPromise(Effect.gen(function* () {
    const repaired = yield* Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...plain, memories: [{ ...plain.memories[0]!, spans: [{ start: 1, end: 2, quote: "A note." }] }] })
    expect((yield* stageKnowledgeExtraction(source, empty, repaired, 30)).memories[0]?.provenance[0]).toEqual({ source: source.ref, start: 0, end: 7, quote: "A note." })
    const repeated = { ...source, text: "A note and another note." }
    const near = (start: number) => Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...plain, memories: [{ ...plain.memories[0]!, spans: [{ start, end: start + 1, quote: "note" }] }] })
    expect((yield* stageKnowledgeExtraction(repeated, empty, yield* near(4), 30)).memories[0]?.provenance[0]).toEqual({ source: source.ref, start: 2, end: 6, quote: "note" })
    expect((yield* stageKnowledgeExtraction(repeated, empty, yield* near(17), 30)).memories[0]?.provenance[0]).toEqual({ source: source.ref, start: 19, end: 23, quote: "note" })
    const invented = yield* Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...plain, memories: [{ ...plain.memories[0]!, spans: [{ start: 2, end: 6, quote: "nothing" }] }] })
    // Its only memory dropped, the extraction keeps no knowledge: its entity alone does not publish.
    const withoutInvented = yield* Effect.flip(stageKnowledgeExtraction(repeated, empty, invented, 30))
    expect([withoutInvented.reason, withoutInvented.message]).toEqual(["Invalid", "The extraction cites an invalid source span"])
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
    const cited = { ref: source.ref, occurredAt: source.occurredAt, recordedAt: source.recordedAt, metadata: { kind: "note" } }
    const dropped = { ...cited, ref: { id: KnowledgeSourceId.make("dropped"), revision: 1 } }
    const result = budgetKnowledgeRecall({ candidates: [{ _tag: "Memory", memory: stage.memories[0]!, score: 1 }], graph: { entities: stage.entities, assertions, truncated: false }, history: [], sources: [cited, dropped] }, 600, 8)
    expect(result.graph.truncated).toBe(true)
    expect(result.graph.assertions.length).toBeGreaterThan(0)
    expect(result.graph.assertions.length).toBeLessThan(20)
    expect(result.candidates).toHaveLength(1)
    expect(result.graph.assertions.every((assertion) => assertion.provenance[0]?.source.id === source.ref.id)).toBe(true)
    expect(result.sources).toEqual([cited])
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

  test("a window's record that names an entity key no part defines is dropped at staging, and a repeated key refuses the source", () => Effect.runPromise(Effect.gen(function* () {
    const windows = knowledgeExtractionWindows(longText, 1_000)
    const stray = (part: string) => {
      const value = windowExtractor(part)
      return { ...value, assertions: [...value.assertions, { ...value.assertions[0]!, key: "stray", subject: "nobody" }] }
    }
    const merged = yield* extractKnowledge({
      source: longSource, snapshot: empty, mode: "document", maxContextChars: 1_000, maxExtractionChars: 1_000, consolidate: true, review: false,
      complete: (prompt) => Schema.decodeUnknownEffect(KnowledgeExtraction)(stray(sourceFrame(prompt))).pipe(Effect.orDie),
    })
    const stage = yield* stageKnowledgeExtraction(longSource, empty, merged, 30)
    expect(stage.assertions).toHaveLength(windows.length)
    expect(stage.notes?.map((note) => [note._tag, Match.valueTags(note, { GraphOmitted: () => "", RecordDropped: (dropped) => dropped.key }), note.message]))
      .toEqual(["stray", ...windows.slice(1).map((window) => `stray~${window.part}`)].map((key) => ["RecordDropped", key, "The extraction refers to an undefined entity key"]))
    const repeated = yield* extractKnowledge({
      source: longSource, snapshot: empty, mode: "document", maxContextChars: 1_000, maxExtractionChars: 1_000, consolidate: true, review: false,
      complete: (prompt) => {
        const value = windowExtractor(sourceFrame(prompt))
        return Schema.decodeUnknownEffect(KnowledgeExtraction)({ ...value, entities: [...value.entities, value.entities[0]!] }).pipe(Effect.orDie)
      },
    }).pipe(Effect.flip)
    expect([repeated.reason, repeated.message]).toEqual(["Invalid", "The extraction repeats an entity key"])
  })))
})

/** "Ann lives in Oslo. Ann drinks tea.": an entity, a memory about her and a relation, each grounded. */
const city: KnowledgeSource = { ...source, ref: { id: KnowledgeSourceId.make("city"), revision: 1 }, text: "Ann lives in Oslo. Ann drinks tea.", occurredAt: 1_700_000_000_000 }
const ann = { key: "ann", name: "Ann", type: "person", aliases: [], existing: null, spans: [{ start: 0, end: 3, quote: "Ann" }] }
const oslo = { key: "oslo", name: "Oslo", type: "city", aliases: [], existing: null, spans: [{ start: 13, end: 17, quote: "Oslo" }] }
const drinks = { key: "drinks", kind: "preference", text: "Ann drinks tea.", entities: ["ann"], spans: [{ start: 19, end: 34, quote: "Ann drinks tea." }], evidence: { _tag: "Stated" }, supersedes: [], supersession: "change" }
const livesIn = { key: "lives", subject: "ann", predicate: "lives_in", object: { _tag: "Entity", key: "oslo" }, text: "Ann lives in Oslo.", spans: [{ start: 0, end: 18, quote: "Ann lives in Oslo." }], validFrom: null, validTo: null, supersedes: [], supersession: "correction" }
const knownAnn = { id: KnowledgeEntityId.make("known-ann"), name: "Ann", type: "person", aliases: [], provenance: [{ source: { id: KnowledgeSourceId.make("earlier"), revision: 1 }, start: 0, end: 3, quote: "Ann" }] }
const knownBergen = { ...knownAnn, id: KnowledgeEntityId.make("known-bergen"), name: "Bergen", type: "city" }
/** Ann lived in Bergen from `from` on, as an earlier source said. */
const livedIn = (from: Option.Option<number>) => ({
  id: KnowledgeAssertionId.make("lived-in-bergen"), subject: knownAnn.id, predicate: "lives_in", object: { _tag: "Entity" as const, entityId: knownBergen.id },
  text: "Ann lives in Bergen.", provenance: knownAnn.provenance, validFrom: from, validTo: Option.none<number>(), knownFrom: 5, knownTo: Option.none<number>(),
})
const withPrior = (from: Option.Option<number>): KnowledgeSnapshot => ({ version: 3, memories: [], graph: { entities: [knownAnn, knownBergen], assertions: [livedIn(from)], truncated: false } })
const moved = (validFrom: number | null) => ({
  entities: [{ ...ann, existing: knownAnn.id }, oslo], memories: [],
  assertions: [{ ...livesIn, supersedes: [livedIn(Option.none()).id], supersession: "change", validFrom }],
})
const stageOf = (snapshot: KnowledgeSnapshot, value: unknown) => Schema.decodeUnknownEffect(KnowledgeExtraction)(value).pipe(Effect.orDie, Effect.flatMap((decoded) => stageKnowledgeExtraction(city, snapshot, decoded, 2_000_000_000_000)))

describe("staging dates undated changes and drops only the records that fail their own checks", () => {
  test("a change without a date takes the source's occurrence time as observed, and the relation it supersedes ends there", () => Effect.runPromise(Effect.gen(function* () {
    const stage = yield* stageOf(withPrior(Option.some(1_600_000_000_000)), moved(null))
    const [current, history] = stage.assertions
    expect([current?.validFrom, current?.validFromBasis, current?.validTo]).toEqual([Option.some(city.occurredAt), "observed", Option.none()])
    expect([history?.id, history?.validFrom, history?.validTo, history?.validFromBasis]).toEqual([KnowledgeAssertionId.make("city:1:history:lives:lived-in-bergen"), Option.some(1_600_000_000_000), Option.some(city.occurredAt), undefined])
    expect([stage.retireAssertions, stage.notes]).toEqual([[livedIn(Option.none()).id], undefined])
  })))

  test("a stated date keeps its basis; the history copy never ends before its relation began", () => Effect.runPromise(Effect.gen(function* () {
    const stated = yield* stageOf(withPrior(Option.none()), moved(1_650_000_000_000))
    expect([stated.assertions[0]?.validFrom, stated.assertions[0]?.validFromBasis, stated.assertions[1]?.validTo]).toEqual([Option.some(1_650_000_000_000), "stated", Option.some(1_650_000_000_000)])
    const later = yield* stageOf(withPrior(Option.some(1_800_000_000_000)), moved(null))
    expect([later.assertions[1]?.validFrom, later.assertions[1]?.validTo]).toEqual([Option.some(1_800_000_000_000), Option.some(1_800_000_000_000)])
    const undated = yield* stageOf(empty, { entities: [ann, oslo], memories: [], assertions: [{ ...livesIn, supersession: "change" }] })
    expect([undated.assertions[0]?.validFrom, undated.assertions[0]?.validFromBasis]).toEqual([Option.none(), undefined])
  })))

  test("a staged record cites its own spans first, before entity evidence and supports, so its first span dates it", () => Effect.runPromise(Effect.gen(function* () {
    const earlier = KnowledgeMemoryId.make("earlier-tea")
    const snapshot: KnowledgeSnapshot = { ...withPrior(Option.none()), memories: [{
      id: earlier, kind: "preference", text: "Ann drank tea.", provenance: knownAnn.provenance, entities: [], evidence: { _tag: "Stated" },
      embedding: Option.none(), knownFrom: 5, knownTo: Option.none(),
    }] }
    const stage = yield* stageOf(snapshot, {
      entities: [{ ...ann, existing: knownAnn.id }, oslo],
      memories: [{ ...drinks, evidence: { _tag: "Inferred", supports: [earlier] } }],
      assertions: [{ ...livesIn, supersedes: [livedIn(Option.none()).id], supersession: "change" }],
    })
    const own = (start: number, end: number) => ({ source: city.ref, start, end, quote: city.text.slice(start, end) })
    // The memory: its own sentence, then its entity's spans here and before, then the supporting memory's evidence.
    expect(stage.memories[0]?.provenance).toEqual([own(19, 34), own(0, 3), ...knownAnn.provenance, ...knownAnn.provenance])
    const [current, history] = stage.assertions
    // The new relation: its own sentence first; its history copy keeps the earlier relation's spans first.
    expect(current?.provenance[0]).toEqual(own(0, 18))
    expect(history?.provenance).toEqual([...livedIn(Option.none()).provenance, own(0, 18)])
    const sources = [{ ref: city.ref, occurredAt: city.occurredAt }, { ref: knownAnn.provenance[0]!.source, occurredAt: 1_500_000_000_000 }]
    expect([stage.memories[0], current, history].map((record) => knowledgeRecordDate(record?.provenance ?? [], sources)))
      .toEqual([Option.some(city.occurredAt), Option.some(city.occurredAt), Option.some(1_500_000_000_000)])
  })))

  test("each record-local failure drops that record with a note and stages the others", () => Effect.runPromise(Effect.gen(function* () {
    const once = KnowledgeMemoryId.make("once")
    const snapshot: KnowledgeSnapshot = { ...empty, memories: [{
      id: once, kind: "action", text: "Ann walked to work.", provenance: knownAnn.provenance, entities: [], evidence: { _tag: "Stated" },
      embedding: Option.none(), knownFrom: 5, knownTo: Option.none(),
    }] }
    const valid = { entities: [ann, oslo], memories: [drinks], assertions: [livesIn] }
    const cases = [
      { change: { ...valid, memories: [{ ...drinks, spans: [{ start: 19, end: 40, quote: "Ann drinks coffee." }] }] }, record: "memory" as const, message: "The extraction cites an invalid source span" },
      { change: { ...valid, memories: [{ ...drinks, entities: ["ann", "bob"] }] }, record: "memory" as const, message: "The extraction refers to an undefined entity key" },
      { change: { ...valid, memories: [{ ...drinks, supersedes: ["retired-elsewhere"] }] }, record: "memory" as const, message: "The extraction retires an unknown or inactive record" },
      { change: { ...valid, memories: [{ ...drinks, evidence: { _tag: "Inferred", supports: ["missing"] } }] }, record: "memory" as const, message: "The extraction cites an unknown supporting memory" },
      { change: { ...valid, memories: [{ ...drinks, kind: "routine", evidence: { _tag: "Inferred", supports: [once] } }] }, record: "memory" as const, message: "An inferred routine needs three distinct supporting episodes" },
      { change: { ...valid, assertions: [{ ...livesIn, object: { _tag: "Entity", key: "bergen" } }] }, record: "assertion" as const, message: "The extraction refers to an undefined entity key" },
      { change: { ...valid, assertions: [{ ...livesIn, supersedes: ["unknown-relation"] }] }, record: "assertion" as const, message: "The extraction retires an unknown or inactive record" },
      { change: { ...valid, assertions: [{ ...livesIn, validFrom: 20, validTo: 10 }] }, record: "assertion" as const, message: "The extraction gives a validity interval that ends before it starts" },
    ]
    const staged = yield* Effect.forEach(cases, ({ change }) => stageOf(snapshot, change), { concurrency: 1 })
    expect(staged.map((stage) => stage.notes)).toEqual(cases.map(({ record, message }) => [{ _tag: "RecordDropped", record, key: record === "memory" ? "drinks" : "lives", reason: "Invalid", message }]))
    // A relation dropped with its object takes Oslo along; one that never named Oslo leaves it as proposed.
    expect(staged.map((stage) => [stage.entities.map((entity) => entity.name), stage.memories.length, stage.assertions.length])).toEqual([
      ...cases.slice(0, 5).map(() => [["Ann", "Oslo"], 0, 1]), [["Ann", "Oslo"], 1, 0], [["Ann"], 1, 0], [["Ann"], 1, 0],
    ])
    expect(staged.every((stage) => stage.retireMemories.length === 0 && stage.retireAssertions.length === 0)).toBe(true)
  })))

  test("a dropped entity takes the records that refer to it along, each with its own note", () => Effect.runPromise(Effect.gen(function* () {
    const unknown = yield* stageOf(empty, { entities: [ann, { ...oslo, existing: "someone-elses-oslo" }], memories: [drinks], assertions: [livesIn] })
    expect(unknown.notes).toEqual([
      { _tag: "RecordDropped", record: "entity", key: "oslo", reason: "Invalid", message: "The extraction names an unknown entity" },
      { _tag: "RecordDropped", record: "assertion", key: "lives", reason: "Invalid", message: "The extraction refers to an entity it dropped" },
    ])
    expect([unknown.entities.map((entity) => entity.name), unknown.memories.map((memory) => memory.text), unknown.assertions]).toEqual([["Ann"], ["Ann drinks tea."], []])
    const withoutOslo = yield* stageOf(empty, { entities: [{ ...ann, spans: [{ start: 0, end: 3, quote: "Ada" }] }, oslo], memories: [drinks], assertions: [{ ...livesIn, object: { _tag: "Value", value: "a city" } }, { ...livesIn, key: "visits", subject: "oslo", object: { _tag: "Value", value: "often" } }] })
    expect(withoutOslo.notes?.map((note) => note.message)).toEqual(["The extraction cites an invalid source span", "The extraction refers to an entity it dropped", "The extraction refers to an entity it dropped"])
    expect([withoutOslo.entities.map((entity) => entity.name), withoutOslo.memories, withoutOslo.assertions.map((assertion) => assertion.text)]).toEqual([["Oslo"], [], ["Ann lives in Oslo."]])
  })))

  test("entities alone are no surviving knowledge: an extraction whose memories and relations all drop fails whole", () => Effect.runPromise(Effect.gen(function* () {
    const unnamedUser = yield* Effect.flip(stageOf(empty, { entities: [ann, oslo], memories: [{ ...drinks, entities: ["user"] }], assertions: [] }))
    const ungrounded = yield* Effect.flip(stageOf(empty, { entities: [{ ...ann, spans: [{ start: 0, end: 3, quote: "Ada" }] }, oslo], memories: [drinks], assertions: [livesIn] }))
    expect([[unnamedUser.reason, unnamedUser.message], [ungrounded.reason, ungrounded.message]]).toEqual([
      ["Invalid", "The extraction refers to an undefined entity key"], ["Invalid", "The extraction cites an invalid source span"],
    ])
    // An extraction of entities only still publishes the entities that pass.
    const entitiesOnly = yield* stageOf(empty, { entities: [ann, { ...oslo, existing: "someone-elses-oslo" }], memories: [], assertions: [] })
    expect([entitiesOnly.entities.map((entity) => entity.name), entitiesOnly.notes?.map((note) => note.message)]).toEqual([["Ann"], ["The extraction names an unknown entity"]])
  })))

  test("a repeated entity key, or an extraction with no surviving record, still fails the whole job", () => Effect.runPromise(Effect.gen(function* () {
    const repeated = yield* Effect.flip(stageOf(empty, { entities: [ann, { ...oslo, key: "ann" }], memories: [drinks], assertions: [] }))
    const none = yield* Effect.flip(stageOf(empty, { entities: [{ ...ann, existing: "elsewhere" }], memories: [drinks], assertions: [] }))
    expect([[repeated.reason, repeated.message], [none.reason, none.message]]).toEqual([
      ["Invalid", "The extraction repeats an entity key"], ["Invalid", "The extraction names an unknown entity"],
    ])
    const nothing = yield* stageOf(empty, { entities: [], memories: [], assertions: [] })
    expect([nothing.entities, nothing.memories, nothing.assertions, nothing.notes]).toEqual([[], [], [], undefined])
  })))
})

describe("staging links each successor to the earlier state it replaced", () => {
  const coffee = KnowledgeMemoryId.make("drank-coffee")
  const withCoffee: KnowledgeSnapshot = { ...withPrior(Option.none()), memories: [{
    id: coffee, kind: "preference", text: "Ann drinks coffee.", provenance: knownAnn.provenance, entities: [knownAnn.id], evidence: { _tag: "Stated" },
    embedding: Option.none(), knownFrom: 5, knownTo: Option.none(),
  }] }
  const replacing = (memory: string, relation: string) => ({
    entities: [{ ...ann, existing: knownAnn.id }, oslo],
    memories: [{ ...drinks, supersedes: [coffee, coffee], supersession: memory }],
    assertions: [{ ...livesIn, supersedes: [livedIn(Option.none()).id], supersession: relation }],
  })

  test("a change links the memory it retires and the relation's history copy; nothing is written to the retired records", () => Effect.runPromise(Effect.gen(function* () {
    const stage = yield* stageOf(withCoffee, replacing("change", "change"))
    const [current, history] = stage.assertions
    expect(stage.memories[0]?.replaces).toEqual([{ id: coffee, supersession: "change" }])
    expect(current?.replaces).toEqual([{ id: history!.id, supersession: "change" }])
    expect([history?.replaces, history?.validTo]).toEqual([undefined, Option.some(city.occurredAt)])
    expect([stage.retireMemories, stage.retireAssertions]).toEqual([[coffee], [livedIn(Option.none()).id]])
  })))

  test("a correction links the retired records themselves, and a record that replaces nothing has no links", () => Effect.runPromise(Effect.gen(function* () {
    const stage = yield* stageOf(withCoffee, replacing("correction", "correction"))
    expect(stage.memories[0]?.replaces).toEqual([{ id: coffee, supersession: "correction" }])
    expect(stage.assertions.map((assertion) => assertion.replaces)).toEqual([[{ id: livedIn(Option.none()).id, supersession: "correction" }]])
    const plainStage = yield* stageOf(empty, { entities: [ann, oslo], memories: [drinks], assertions: [livesIn] })
    expect([plainStage.memories[0] !== undefined && "replaces" in plainStage.memories[0], plainStage.assertions[0] !== undefined && "replaces" in plainStage.assertions[0]]).toEqual([false, false])
  })))

  test("an extracted memory states why it supersedes, and a memory or relation stored before links decodes without them", () => Effect.runPromise(Effect.gen(function* () {
    const missing = yield* Effect.flip(Schema.decodeUnknownEffect(KnowledgeExtraction)({ entities: [], assertions: [], memories: [{ ...drinks, supersession: undefined }] }))
    expect(missing._tag).toBe("SchemaError")
    const stored = yield* Schema.decodeUnknownEffect(KnowledgeMemory)({ id: "m", kind: "fact", text: "A note.", provenance: [{ source: { id: "s", revision: 1 }, start: 0, end: 7, quote: "A note." }], entities: [], evidence: { _tag: "Stated" }, embedding: null, knownFrom: 1, knownTo: null })
    expect("replaces" in stored).toBe(false)
    const result = yield* Schema.decodeUnknownEffect(KnowledgeRecallResult)({ candidates: [], graph: { entities: [], assertions: [], truncated: false } })
    expect([result.history, result.sources]).toEqual([[], []])
  })))
})

describe("the recall budget gives earlier states at most their share", () => {
  const span = (id: string, text: string) => ({ source: { id: KnowledgeSourceId.make(id), revision: 1 }, start: 0, end: text.length, quote: text })
  const memory = (id: string, text: string, replaces: ReadonlyArray<string> = []) => ({
    id: KnowledgeMemoryId.make(id), kind: "preference" as const, text, provenance: [span(id, text)], entities: [], evidence: { _tag: "Stated" as const },
    embedding: Option.none(), knownFrom: 1, knownTo: replaces.length === 0 && id.startsWith("old") ? Option.some(2) : Option.none<number>(),
    ...(replaces.length === 0 ? {} : { replaces: replaces.map((prior) => ({ id: KnowledgeMemoryId.make(prior), supersession: "change" as const })) }),
  })
  const candidate = (record: ReturnType<typeof memory>) => ({ _tag: "Memory" as const, memory: record, score: 1 })
  const earlier = (successor: string, record: ReturnType<typeof memory>) => ({ _tag: "Memory" as const, successor: `memory:${successor}`, record, supersession: "change" as const, until: 2 })
  const current = Array.from({ length: 6 }, (_, index) => candidate(memory(`new${index}`, `Current record number ${index} about the drink.`, [`old${index}`])))
  const history = current.map((_, index) => earlier(`new${index}`, memory(`old${index}`, `Earlier record number ${index} about the drink.`)))
  const graph = { entities: [], assertions: [], truncated: false }
  const costOf = (text: string, id: string) => text.length + `\nSource: ${id} revision 1, characters 0-${text.length}`.length + 2

  test("earlier states never exceed their share, follow their successors' rank, and at most half the limit", () => {
    const perRecord = costOf(current[0]!.memory.text, "new0")
    const maxChars = perRecord * 5
    const result = budgetKnowledgeRecall({ candidates: current, graph, history: [...history].reverse(), sources: [] }, maxChars, 6, 0.2)
    const used = result.history.reduce((sum, state) => sum + costOf(state.record.text, state.record.id), 0)
    expect(used).toBeLessThanOrEqual(Math.floor(maxChars * 0.2))
    expect(result.history.map((state) => state.successor)).toEqual(["memory:new0"])
    expect(result.candidates.map((value): string => value._tag === "Memory" ? value.memory.id : "")).toEqual(["new0", "new1", "new2", "new3"])
    const wide = budgetKnowledgeRecall({ candidates: current, graph, history, sources: [] }, perRecord * 20, 6, 0.5)
    expect(wide.history.map((state) => state.successor)).toEqual(["memory:new0", "memory:new1", "memory:new2"])
    expect(wide.candidates).toHaveLength(6)
  })

  test("an unused share goes to current records, and no history or a zero share budgets as before", () => {
    const perRecord = costOf(current[0]!.memory.text, "new0")
    const maxChars = perRecord * 5
    const without = budgetKnowledgeRecall({ candidates: current, graph, history: [], sources: [] }, maxChars, 6, 0.2)
    expect(without.candidates).toHaveLength(5)
    // An earlier state whose successor did not make the first pass is never followed: its share returns to current records.
    const orphaned = budgetKnowledgeRecall({ candidates: current, graph, history: [earlier("new5", memory("old5", "Earlier record number 5 about the drink."))], sources: [] }, maxChars, 6, 0.2)
    expect([orphaned.candidates.length, orphaned.history]).toEqual([5, []])
    expect(budgetKnowledgeRecall({ candidates: current, graph, history, sources: [] }, maxChars, 6, 0)).toEqual(without)
    // A share too small for the earliest state also returns whole: the result is the one without history.
    expect(budgetKnowledgeRecall({ candidates: current, graph, history, sources: [] }, maxChars, 6, 0.05)).toEqual(without)
    // An earlier state already kept as a current record, or repeated, is shown once and only as current.
    const current0 = { ...earlier("new1", current[0]!.memory) }
    const duplicate = budgetKnowledgeRecall({ candidates: current, graph, history: [current0, history[0]!, history[0]!], sources: [] }, perRecord * 20, 6, 0.5)
    expect(duplicate.history.map((state): string => state.record.id)).toEqual(["old0"])
  })
})
