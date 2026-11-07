import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { KnowledgeChunkId, KnowledgeMemoryId, KnowledgeSourceId, fuseKnowledgeCandidates, knowledgeMemorySupport } from "@xandreed/core"
import type { KnowledgeCandidate, KnowledgeMemory, KnowledgeSourceInfo, KnowledgeSupport } from "@xandreed/core"
import { collapseMemoryCandidates, memoryPastFactor, memorySupportFactor } from "./memory.entity.functions.js"
import { memoryDefaults } from "./memory.entity.js"

const ref = { id: KnowledgeSourceId.make("source"), revision: 1 }
const memoryOf = (id: string, kind: KnowledgeMemory["kind"], episodes?: number): KnowledgeCandidate => ({
  _tag: "Memory", score: 0,
  memory: { id: KnowledgeMemoryId.make(id), kind, text: `${id}.`, entities: [], evidence: { _tag: "Stated" }, embedding: Option.none(), knownFrom: 1, knownTo: Option.none(), provenance: [{ source: ref, start: 0, end: 1, quote: "x" }] },
  ...(episodes === undefined ? {} : { support: { episodes, sources: episodes, firstSeen: 1, lastSeen: 2 } satisfies KnowledgeSupport }),
})
const weight = memoryDefaults.supportWeight

describe("recall's support factor", () => {
  test("is 1 + supportWeight × ln(min(episodes, 4)) for the kinds repetition supports, and 1 otherwise", () => {
    expect(weight).toBe(0.15)
    expect(memorySupportFactor(memoryOf("once", "preference", 1), weight)).toBe(1)
    expect(memorySupportFactor(memoryOf("twice", "routine", 2), weight)).toBeCloseTo(1 + 0.15 * Math.log(2), 12)
    expect(memorySupportFactor(memoryOf("four", "profile", 4), weight)).toBeCloseTo(1.2079, 4)
    // Bounded: ten episodes count as four.
    expect(memorySupportFactor(memoryOf("ten", "fact", 10), weight)).toBe(memorySupportFactor(memoryOf("four", "fact", 4), weight))
    // Other kinds, a memory without support, a chunk and a weight of 0 are never boosted.
    expect(["decision", "goal", "action"].map((kind) => memorySupportFactor(memoryOf("kind", kind as KnowledgeMemory["kind"], 4), weight))).toEqual([1, 1, 1])
    expect(memorySupportFactor(memoryOf("unsupported", "preference"), weight)).toBe(1)
    expect(memorySupportFactor({ _tag: "Chunk", score: 0, chunk: { id: KnowledgeChunkId.make("chunk"), text: "x", provenance: { source: ref, start: 0, end: 1, quote: "x" }, embedding: Option.none() } }, weight)).toBe(1)
    expect(memorySupportFactor(memoryOf("four", "preference", 4), 0)).toBe(1)
  })

  test("is bounded: a rank-0 relevant fact stays ahead of a preference said in four episodes ranked twentieth", () => {
    const factor = (candidate: KnowledgeCandidate) => memorySupportFactor(candidate, weight)
    const order = (fused: ReadonlyArray<KnowledgeCandidate>) => fused.map((candidate) => candidate._tag === "Memory" ? String(candidate.memory.id) : "")
    // A relevant fact both arms rank first, then nineteen single-episode records, then a preference said in four episodes.
    const filler = Array.from({ length: 19 }, (_, index) => memoryOf(`filler-${String(index).padStart(2, "0")}`, "preference", 1))
    const fact = memoryOf("fact", "fact", 1)
    const repeated = memoryOf("repeated", "preference", 4)
    const list = [fact, ...filler, repeated]
    const ranked = order(fuseKnowledgeCandidates({ lexical: list, semantic: list }, 100, 100_000, factor))
    // Rank 0 stays first: 2/61 against 1.2079 × 2/81. The preference passes the records ranked 7 to 19 (2/68 and below)
    // and no record ranked 6 or better (2/67 and above): at most ×1.21 moves a record past records within about a sixth
    // of its fused rank (61 + rank), so near the top it needs to be within twelve places of the record it passes.
    expect(ranked[0]).toBe("fact")
    expect(ranked.indexOf("repeated")).toBe(7)
    // Adjacent records: one said in four episodes moves ahead of one said once.
    expect(order(fuseKnowledgeCandidates({ lexical: [memoryOf("a-once", "preference", 1), repeated], semantic: [memoryOf("a-once", "preference", 1), repeated] }, 10, 1_000, factor))).toEqual(["repeated", "a-once"])
    // Without support the ranking is plain fusion.
    expect(order(fuseKnowledgeCandidates({ lexical: list, semantic: list }, 100, 100_000, factor)).slice(0, 1)).toEqual(order(fuseKnowledgeCandidates({ lexical: list, semantic: list }, 100, 100_000)).slice(0, 1))
  })
})

describe("recall's event factor", () => {
  const marked = (candidate: KnowledgeCandidate, past: boolean): KnowledgeCandidate => candidate._tag === "Memory" ? { ...candidate, past } : candidate
  const past = (candidate: KnowledgeCandidate) => marked(candidate, true)
  test("is pastEventWeight for a memory marked past, and 1 for every other candidate", () => {
    expect(memoryDefaults.pastEventWeight).toBe(0.5)
    expect(memoryPastFactor(past(memoryOf("exhibition", "preference")), 0.5)).toBe(0.5)
    expect(memoryPastFactor(memoryOf("pottery", "preference"), 0.5)).toBe(1)
    expect(memoryPastFactor(marked(memoryOf("unmarked", "goal"), false), 0.5)).toBe(1)
    expect(memoryPastFactor(past(memoryOf("exhibition", "preference")), 1)).toBe(1)
  })

  test("demotes a past record below a current one of similar relevance without removing it, and composes with support", () => {
    const order = (fused: ReadonlyArray<KnowledgeCandidate>) => fused.map((candidate) => candidate._tag === "Memory" ? String(candidate.memory.id) : "")
    const exhibition = past(memoryOf("exhibition", "preference", 1))
    const pottery = memoryOf("pottery", "preference", 1)
    const lists = { lexical: [exhibition, pottery], semantic: [exhibition, pottery] }
    const factor = (weight: number) => (candidate: KnowledgeCandidate) => memorySupportFactor(candidate, memoryDefaults.supportWeight) * memoryPastFactor(candidate, weight)
    // Plain fusion ranks the past record first; demoted, it follows the current one and is still returned.
    expect(order(fuseKnowledgeCandidates(lists, 10, 1_000))).toEqual(["exhibition", "pottery"])
    expect(order(fuseKnowledgeCandidates(lists, 10, 1_000, factor(0.5)))).toEqual(["pottery", "exhibition"])
    expect(order(fuseKnowledgeCandidates(lists, 10, 1_000, factor(1)))).toEqual(["exhibition", "pottery"])
    // A weight of 0 ranks it last, never drops it.
    expect(order(fuseKnowledgeCandidates(lists, 10, 1_000, factor(0)))).toEqual(["pottery", "exhibition"])
    // Halved, a past record said in four episodes (at most x1.21) still follows a current one ranked just below it.
    const repeated = past(memoryOf("exhibition", "preference", 4))
    expect(order(fuseKnowledgeCandidates({ lexical: [repeated, pottery], semantic: [repeated, pottery] }, 10, 1_000, factor(0.5)))).toEqual(["pottery", "exhibition"])
  })
})

describe("recall's near-duplicate collapse", () => {
  const space = { model: "kit", version: "1", dimensions: 2 }
  const sourceOf = (name: string) => ({ id: KnowledgeSourceId.make(name), revision: 1 })
  /** A stated memory said in its own source (`id`), embedded at `values`. */
  const said = (id: string, kind: KnowledgeMemory["kind"], values: ReadonlyArray<number> | undefined, more: Partial<KnowledgeMemory> = {}): KnowledgeCandidate => ({
    _tag: "Memory", score: 1,
    memory: {
      id: KnowledgeMemoryId.make(id), kind, text: `${id}.`, entities: [], evidence: { _tag: "Stated" }, knownFrom: 1, knownTo: Option.none(),
      embedding: values === undefined ? Option.none() : Option.some({ space, values }), provenance: [{ source: sourceOf(id), start: 0, end: 3, quote: id.slice(0, 3) }], mentions: [sourceOf(id)], ...more,
    },
  })
  const chunk: KnowledgeCandidate = { _tag: "Chunk", score: 1, chunk: { id: KnowledgeChunkId.make("passage"), text: "passage", provenance: { source: sourceOf("doc"), start: 0, end: 7, quote: "passage" }, embedding: Option.some({ space, values: [1, 0] }) } }
  // Each source is its own episode, said a day apart.
  const infos: ReadonlyArray<KnowledgeSourceInfo> = ["a", "b", "c", "d", "e", "f"].map((name, index) => ({ ref: sourceOf(name), occurredAt: (index + 1) * 86_400_000, recordedAt: 0, metadata: {} }))
  const support = (memory: KnowledgeMemory) => knowledgeMemorySupport(memory, infos)
  const shown = (candidates: ReadonlyArray<KnowledgeCandidate>) => candidates.map((candidate) => candidate._tag === "Memory"
    ? [String(candidate.memory.id), (candidate.alike ?? []).map(String), candidate.support?.episodes ?? 0] : [String(candidate.chunk.id), [], 0])

  test("folds a memory into a kept one ranked above it of the same kind whose cosine reaches the threshold, never another kind", () => {
    // cos(a, b) ≈ 0.995, cos(a, c) ≈ 0.995 but c is a preference, cos(a, d) ≈ 0.894.
    const ranked = [said("a", "fact", [1, 0]), said("b", "fact", [1, 0.1]), said("c", "preference", [1, 0.1]), said("d", "fact", [1, 0.5])]
    expect(shown(collapseMemoryCandidates(ranked, 0.95, support))).toEqual([["a", ["b"], 2], ["c", [], 0], ["d", [], 0]])
    // The threshold decides: at 0.85 the fact at 0.894 folds too; at 0.999 nothing does.
    expect(shown(collapseMemoryCandidates(ranked, 0.85, support))).toEqual([["a", ["b", "d"], 3], ["c", [], 0]])
    expect(shown(collapseMemoryCandidates(ranked, 0.999, support))).toEqual([["a", [], 0], ["b", [], 0], ["c", [], 0], ["d", [], 0]])
    // A cosine exactly at the threshold folds.
    expect(shown(collapseMemoryCandidates([said("a", "fact", [3, 4]), said("b", "fact", [3, 4])], 1, support))).toEqual([["a", ["b"], 2]])
  })

  test("the kept memory carries the folded memories' spans and mentions, and its support counts their episodes", () => {
    const [kept] = collapseMemoryCandidates([said("a", "routine", [1, 0]), said("b", "routine", [1, 0.05]), said("c", "routine", [1, 0.02])], 0.95, support)
    expect(kept?._tag).toBe("Memory")
    if (kept?._tag !== "Memory") return
    expect([String(kept.memory.id), kept.memory.text, kept.score]).toEqual(["a", "a.", 1])
    expect(kept.memory.provenance.map((span) => String(span.source.id))).toEqual(["a", "b", "c"])
    expect(kept.memory.mentions?.map((ref) => String(ref.id))).toEqual(["a", "b", "c"])
    expect(kept.support).toEqual({ episodes: 3, sources: 3, firstSeen: 86_400_000, lastSeen: 3 * 86_400_000 })
    // A mention two of them share counts once; without any info, the kept memory keeps the support it had.
    const shared = collapseMemoryCandidates([said("a", "fact", [1, 0]), said("b", "fact", [1, 0], { mentions: [sourceOf("b"), sourceOf("a")] })], 0.95, support)
    expect(shared[0]?._tag === "Memory" ? [shared[0].memory.mentions?.map((ref) => String(ref.id)), shared[0].support?.sources] : []).toEqual([["a", "b"], 2])
    const first = said("a", "fact", [1, 0])
    const supported: KnowledgeCandidate = first._tag === "Memory" ? { ...first, support: { episodes: 1, sources: 1, firstSeen: 5, lastSeen: 5 } } : first
    const unread = collapseMemoryCandidates([supported, said("b", "fact", [1, 0])], 0.95, () => Option.none())
    expect(unread[0]?._tag === "Memory" ? unread[0].support : undefined).toEqual({ episodes: 1, sources: 1, firstSeen: 5, lastSeen: 5 })
  })

  test("is deterministic and keeps ranks: the highest-ranked memory is kept, each fold goes to the first kept match, passages stay in place", () => {
    // b repeats a; e repeats d (cos ≈ 0.999) and a only at ≈ 0.95 under the threshold; f repeats a and d, folding into a, ranked first.
    const ranked = [said("a", "fact", [1, 0]), chunk, said("b", "fact", [1, 0.01]), said("d", "fact", [0.95, 0.32]), said("e", "fact", [0.96, 0.3]), said("f", "fact", [0.99, 0.15])]
    const once = collapseMemoryCandidates(ranked, 0.97, support)
    expect(shown(once)).toEqual([["a", ["b", "f"], 3], ["passage", [], 0], ["d", ["e"], 2]])
    expect(collapseMemoryCandidates(ranked, 0.97, support)).toEqual(once)
    // A memory without an embedding, or with another event time, is never folded and never folds another.
    const apart = [said("a", "goal", [1, 0], { eventAt: { start: 10 } }), said("b", "goal", [1, 0], { eventAt: { start: 20 } }), said("c", "goal", undefined), said("e", "goal", [1, 0], { eventAt: { start: 10 } })]
    expect(shown(collapseMemoryCandidates(apart, 0.95, support))).toEqual([["a", ["e"], 2], ["b", [], 0], ["c", [], 0]])
    // A passage, even one embedded exactly as a memory, is never folded nor folds one.
    expect(shown(collapseMemoryCandidates([chunk, said("a", "fact", [1, 0])], 0.95, support))).toEqual([["passage", [], 0], ["a", [], 0]])
  })
})
