import type { DecisionTrial, SelectionObservation } from "./decision-comparison.entity.js"

const sampleIndex = (draw: number, position: number, length: number) => {
  const seed = (Math.imul(draw + 1, 0x9e3779b1) + Math.imul(position + 1, 0x85ebca6b)) >>> 0
  const first = Math.imul(seed ^ (seed >>> 16), 0x7feb352d)
  const second = Math.imul(first ^ (first >>> 15), 0x846ca68b)
  return ((second ^ (second >>> 16)) >>> 0) % length
}
const mean = (xs: ReadonlyArray<number>) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const quantile = (xs: ReadonlyArray<number>, q: number) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * q) - 1)] ?? null
export const selectionMetrics = (rows: ReadonlyArray<SelectionObservation>) => {
  const accepted = rows.filter((r) => r.selected !== null)
  // Choice probabilities require a single categorical gold label. Multiple
  // acceptable alternatives still support accuracy, but not a unique Brier target.
  const categorical = rows.filter((r) => r.acceptable.length <= 1 && Object.keys(r.probabilities).length > 0 && Object.hasOwn(r.probabilities, r.acceptable[0] ?? "abstain"))
  return {
    probabilityCases: categorical.length,
    attempts: rows.length, accepted: accepted.length,
    coverage: rows.length ? accepted.length / rows.length : null,
    acceptedErrorRate: accepted.length ? accepted.filter((r) => !r.acceptable.includes(r.selected ?? "")).length / accepted.length : null,
    brier: mean(categorical.map((r) => Object.entries(r.probabilities).reduce((sum, [id, probability]) => sum + (probability - Number(id === (r.acceptable[0] ?? "abstain"))) ** 2, 0))),
  }
}
/** Matching keys include repetition. Missing pairs are counted, never treated as ties.
 * Bootstrap units are scenario groups, so translations and repetitions stay together. */
export const compareDecisionTrials = (rows: ReadonlyArray<DecisionTrial>, baseline: string) => {
  const base = rows.filter((r) => r.candidate === baseline)
  return [...new Set(rows.map((r) => r.candidate))].map((candidate) => {
    const current = rows.filter((r) => r.candidate === candidate)
    const pairs = current.flatMap((r) => {
      const b = base.find((v) => v.caseId === r.caseId && v.sample === r.sample)
      return b ? [{ b, r }] : []
    })
    const deltas = (field: "quality" | "latencyMs" | "costUsd") => {
      const valid = pairs.filter(({ b, r }) => b.status !== "infrastructure" && r.status !== "infrastructure" && b[field] !== null && r[field] !== null)
      const groups = [...new Set(valid.map(({ r }) => r.group))].map((group) => mean(valid.filter(({ r }) => r.group === group).map(({ b, r }) => (r[field] ?? 0) - (b[field] ?? 0))) ?? 0)
      const draws = groups.length < 2 ? [] : Array.from({ length: 1000 }, (_, n) => mean(Array.from({ length: groups.length }, (_, k) => groups[sampleIndex(n, k, groups.length)] ?? 0)) ?? 0)
      return { pairs: valid.length, groups: groups.length, mean: mean(groups), low: quantile(draws, .025), high: quantile(draws, .975) }
    }
    const costs = current.flatMap((r) => r.costUsd === null ? [] : [r.costUsd])
    const successes = current.filter((r) => r.status === "completed" && r.passed).length
    return {
      candidate, attempts: current.length, successes, infrastructure: current.filter((r) => r.status === "infrastructure").length,
      pairs: pairs.length, missingPairs: Math.max(base.length, current.length) - pairs.length,
      measuredCostCalls: costs.length,
      costPerSuccess: costs.length === current.length && successes > 0 ? costs.reduce((a, b) => a + b, 0) / successes : null,
      p50Ms: quantile(current.flatMap((r) => r.latencyMs === null ? [] : [r.latencyMs]), .5),
      p95Ms: quantile(current.flatMap((r) => r.latencyMs === null ? [] : [r.latencyMs]), .95),
      quality: deltas("quality"), latency: deltas("latencyMs"), cost: deltas("costUsd"),
      regressions: pairs.filter(({ b, r }) => b.passed && !r.passed && r.status !== "infrastructure").map(({ r }) => r.caseId),
    }
  })
}
