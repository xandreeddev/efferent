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
