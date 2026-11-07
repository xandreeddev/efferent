import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { KnowledgeChunkId, KnowledgeMemoryId, KnowledgeSourceId, fuseKnowledgeCandidates } from "@xandreed/core"
import type { KnowledgeCandidate, KnowledgeMemory, KnowledgeSupport } from "@xandreed/core"
import { memoryPastFactor, memorySupportFactor } from "./memory.entity.functions.js"
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
