/** Wilson score interval for a binomial proportion. Stable at p=0/1 where
 *  the naive normal interval collapses to false certainty. */
export const wilsonInterval = (
  successes: number,
  trials: number,
  z = 1.96,
): { readonly low: number; readonly high: number } => {
  if (trials <= 0) return { low: 0, high: 1 }
  const p = successes / trials
  const z2 = z * z
  const denominator = 1 + z2 / trials
  const center = (p + z2 / (2 * trials)) / denominator
  const margin =
    (z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) /
    denominator
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) }
}

/** The q-th percentile by nearest-rank; `+Infinity` for an empty sample so a
 *  candidate with no measurements never looks fast. */
export const percentile = (values: ReadonlyArray<number>, q: number): number => {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(q * ordered.length) - 1))]!
}

export const mean = (values: ReadonlyArray<number>): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

/** Population standard deviation; 0 below two samples. */
export const standardDeviation = (values: ReadonlyArray<number>): number => {
  const average = mean(values)
  return values.length < 2 ? 0 : Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
}
