import type { Spawn } from "./scenarioRun.js"

/**
 * Multi-agent COORDINATION metrics — the system-level signals a per-agent score
 * misses (MAST + Anthropic's multi-agent playbook). Computed purely from the
 * captured trajectory; unit-tested with synthetic spawns.
 */
export interface CoordinationMetrics {
  /** How many sub-agents the run spawned. */
  readonly spawnCount: number
  /** Sub-agents that ended in error. */
  readonly failedSpawns: number
  /** Files written by >1 sub-agent ÷ distinct files written — duplicated/conflicting
   *  work (measured at 53–86% across multi-agent frameworks). 0 when ≤1 writer. */
  readonly writerOverlap: number
  /** Spawns beyond the expected number of independent areas (over-delegation). */
  readonly overSpawn: number
}

export const coordinationMetrics = (
  spawns: ReadonlyArray<Spawn>,
  expectedAreas = 1,
): CoordinationMetrics => {
  const fileCounts = new Map<string, number>()
  for (const s of spawns) for (const f of s.files) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1)
  const distinct = fileCounts.size
  const overlapped = [...fileCounts.values()].filter((c) => c > 1).length
  return {
    spawnCount: spawns.length,
    failedSpawns: spawns.filter((s) => !s.ok).length,
    writerOverlap: distinct === 0 ? 0 : overlapped / distinct,
    overSpawn: Math.max(0, spawns.length - expectedAreas),
  }
}

/**
 * A coordination SCORE in [0,1] — 1 when the fleet was tidy (no over-spawn, no
 * duplicated writes, no failed sub-agents), decaying with each. Use on breadth
 * scenarios where delegation is expected.
 */
export const coordinationScore = (m: CoordinationMetrics): number => {
  let score = 1
  score -= Math.min(0.5, m.overSpawn * 0.25) // over-delegation
  score -= Math.min(0.3, m.writerOverlap * 0.3) // duplicated/conflicting work
  if (m.spawnCount > 0) score -= Math.min(0.3, (m.failedSpawns / m.spawnCount) * 0.3)
  return Math.max(0, score)
}

/**
 * `agentevals`-style deterministic trajectory match over a tool-name sequence —
 * a cheap, no-LLM regression gate (reserve the LLM/agent-judge for semantics):
 * - `strict`    — same tools, same order (order is load-bearing, e.g. a protocol).
 * - `unordered` — same multiset of tools, any order.
 * - `superset`  — every REQUIRED tool ran (e.g. the architect/verify step happened).
 * - `subset`    — only expected tools ran, nothing extra (efficiency / no over-tooling).
 */
export type MatchMode = "strict" | "unordered" | "subset" | "superset"

export const trajectoryMatch = (
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  mode: MatchMode,
): boolean => {
  switch (mode) {
    case "strict":
      return actual.length === expected.length && actual.every((t, i) => t === expected[i])
    case "unordered": {
      const a = [...actual].sort()
      const e = [...expected].sort()
      return a.length === e.length && a.every((t, i) => t === e[i])
    }
    case "superset":
      return expected.every((t) => actual.includes(t))
    case "subset": {
      const allowed = new Set(expected)
      return actual.every((t) => allowed.has(t))
    }
  }
}
