import { Match, Option } from "effect"
import { corroborateKnowledgeMemory, knowledgeCosine, knowledgeMemoryMentions } from "@xandreed/core"
import type { KnowledgeCandidate, KnowledgeMemory, KnowledgeMemoryKind, KnowledgeSupport } from "@xandreed/core"

/** The kinds whose repetition says something about the person: stating one again is evidence it holds. */
const SUPPORTED_KINDS: ReadonlyArray<KnowledgeMemoryKind> = ["preference", "routine", "profile", "fact"]
/** Episodes beyond this many add nothing: the boost is bounded at `1 + supportWeight × ln 4`. */
export const SUPPORT_EPISODE_CAP = 4

/**
 * A recall candidate's support factor (`MemoryConfig.supportWeight`): `1 + supportWeight ×
 * ln(min(episodes, 4))` for a preference, routine, profile or fact memory with `support`, and 1 for
 * every other candidate (a chunk, another kind, a memory without support or stated once).
 */
export const memorySupportFactor = (candidate: KnowledgeCandidate, supportWeight: number): number =>
  candidate._tag === "Memory" && candidate.support !== undefined && SUPPORTED_KINDS.includes(candidate.memory.kind)
    ? 1 + supportWeight * Math.log(Math.min(Math.max(candidate.support.episodes, 1), SUPPORT_EPISODE_CAP))
    : 1

/**
 * A recall candidate's event factor (`MemoryConfig.pastEventWeight`): `pastEventWeight` for a memory
 * recall marked `past` (`knowledgeMemoryIsPast`), and 1 for every other candidate.
 */
export const memoryPastFactor = (candidate: KnowledgeCandidate, pastEventWeight: number): number =>
  candidate._tag === "Memory" && candidate.past === true ? pastEventWeight : 1

/**
 * Whether `later` repeats `kept` closely enough to be shown as it: the same kind and event time (both
 * none, or the same start and end), and embeddings whose cosine is at least `minSimilarity`. A memory
 * without an embedding repeats none.
 */
const repeats = (kept: KnowledgeMemory, later: KnowledgeMemory, minSimilarity: number): boolean =>
  kept.kind === later.kind && kept.eventAt?.start === later.eventAt?.start && kept.eventAt?.end === later.eventAt?.end
  && Option.isSome(kept.embedding) && Option.isSome(later.embedding) && knowledgeCosine(kept.embedding.value, later.embedding.value) >= minSimilarity

/** A kept candidate and the memories folded into it, in rank order. */
interface CollapseGroup { readonly kept: KnowledgeCandidate; readonly folded: ReadonlyArray<KnowledgeMemory> }

/**
 * Recall's near-duplicate collapse (`MemoryConfig.recallCollapseSimilarity`), over candidates in rank
 * order: each memory that repeats a memory ranked above it and kept (the same kind and event time, the
 * cosine of their embeddings at least `minSimilarity`) is folded into the first such one; every other
 * candidate, and every passage, is kept in its place. A kept memory that folded others names them in
 * `alike`, in rank order, and carries their evidence as publication carries a restatement's
 * (`corroborateKnowledgeMemory`): their spans after its own in its provenance, and the revisions that
 * state them (`knowledgeMemoryMentions`) after its own in its mentions, each once. Its `support` is
 * what `supportOf` counts for it so, keeping its own when that is none; its id, text, kind, score and
 * first span stay its own. Pure and deterministic: the same ranked list folds the same way.
 */
export const collapseMemoryCandidates = (
  ranked: ReadonlyArray<KnowledgeCandidate>, minSimilarity: number, supportOf: (memory: KnowledgeMemory) => Option.Option<KnowledgeSupport>,
): ReadonlyArray<KnowledgeCandidate> => {
  const groups = ranked.reduce<ReadonlyArray<CollapseGroup>>((kept, candidate) => {
    const into = Match.valueTags(candidate, {
      Memory: ({ memory }) => kept.findIndex((group) => group.kept._tag === "Memory" && repeats(group.kept.memory, memory, minSimilarity)),
      Chunk: () => -1,
    })
    return into < 0 ? [...kept, { kept: candidate, folded: [] }]
      : kept.map((group, index) => index === into && candidate._tag === "Memory" ? { ...group, folded: [...group.folded, candidate.memory] } : group)
  }, [])
  return groups.map(({ kept, folded }) => Match.valueTags(kept, {
    Memory: (memory): KnowledgeCandidate => {
      if (folded.length === 0) return memory
      const merged = folded.reduce((record, alike) => knowledgeMemoryMentions(alike).reduce(
        (current, mention) => corroborateKnowledgeMemory(current, { memory: current.id, mention, provenance: alike.provenance }), record,
      ), memory.memory)
      return {
        ...memory, memory: merged, alike: folded.map((record) => record.id),
        ...Option.match(supportOf(merged), { onNone: () => ({}), onSome: (support) => ({ support }) }),
      }
    },
    Chunk: (chunk): KnowledgeCandidate => chunk,
  }))
}
