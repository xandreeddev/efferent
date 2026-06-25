/**
 * Is a score difference between two runs real, or sampling noise? With a small
 * golden set the honest answer is a confidence interval, not a point delta. We
 * pair by scenario (the SAME cases run under both configs) and bootstrap the
 * 95% CI of the mean per-case delta; "significant" means the CI excludes 0.
 *
 * Deterministic by design — a fixed-seed PRNG (mulberry32) so the same data
 * yields the same CI every run (reproducible, unit-testable). No deps.
 */

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface DeltaCI {
  /** Mean per-case delta (candidate − baseline). */
  readonly delta: number
  /** 95% bootstrap CI bounds of the mean delta. */
  readonly low: number
  readonly high: number
  /** The CI excludes 0 → the difference is unlikely to be noise. */
  readonly significant: boolean
  /** Number of paired cases the CI is built from. */
  readonly n: number
}

/**
 * Paired bootstrap 95% CI of the mean delta `candidate[i] − baseline[i]`.
 * Inputs are per-case means aligned by scenario (caller pairs by name). With
 * < 2 pairs the CI is degenerate and never "significant".
 */
export const pairedDeltaCI = (
  baseline: ReadonlyArray<number>,
  candidate: ReadonlyArray<number>,
  iterations = 2000,
  seed = 0x5eed1e,
): DeltaCI => {
  const n = Math.min(baseline.length, candidate.length)
  const deltas = Array.from({ length: n }, (_, i) => candidate[i]! - baseline[i]!)
  const delta = n === 0 ? 0 : deltas.reduce((a, b) => a + b, 0) / n
  if (n < 2) return { delta, low: delta, high: delta, significant: false, n }

  const rng = mulberry32(seed)
  const means: Array<number> = []
  for (let it = 0; it < iterations; it++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += deltas[Math.floor(rng() * n)]!
    means.push(sum / n)
  }
  means.sort((a, b) => a - b)
  const low = means[Math.floor(0.025 * iterations)]!
  const high = means[Math.min(iterations - 1, Math.floor(0.975 * iterations))]!
  return { delta, low, high, significant: low > 0 || high < 0, n }
}
