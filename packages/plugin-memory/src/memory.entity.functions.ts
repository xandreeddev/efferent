import type { KnowledgeCandidate, KnowledgeMemoryKind } from "@xandreed/core"

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
