/**
 * Agreement metrics for judge calibration — pure, dependency-free, unit-tested.
 * They answer "does the LLM judge track human labels, or is it making numbers
 * up?". An eval score is only as trustworthy as the judge that produced it, so
 * these are run against a human-labeled golden set (see `judgeGolden.ts`).
 */

export interface Pair {
  /** Ground-truth human score, 0..1. */
  readonly human: number
  /** The judge's score, 0..1. */
  readonly judge: number
}

const mean = (ns: ReadonlyArray<number>): number =>
  ns.length === 0 ? 0 : ns.reduce((a, b) => a + b, 0) / ns.length

/** Mean absolute error — average |human − judge|. Lower is better (0 = perfect). */
export const mae = (pairs: ReadonlyArray<Pair>): number =>
  mean(pairs.map((p) => Math.abs(p.human - p.judge)))

/** Root mean squared error — penalizes large misses more than MAE. */
export const rmse = (pairs: ReadonlyArray<Pair>): number =>
  Math.sqrt(mean(pairs.map((p) => (p.human - p.judge) ** 2)))

/** Signed bias — mean (judge − human). >0 ⇒ the judge is systematically lenient. */
export const bias = (pairs: ReadonlyArray<Pair>): number =>
  mean(pairs.map((p) => p.judge - p.human))

/** Pearson correlation of two equal-length series. 0 for <2 points or zero variance. */
export const pearson = (xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number => {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return 0
  const mx = mean(xs.slice(0, n))
  const my = mean(ys.slice(0, n))
  let num = 0
  let dx2 = 0
  let dy2 = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx
    const dy = ys[i]! - my
    num += dx * dy
    dx2 += dx * dx
    dy2 += dy * dy
  }
  const den = Math.sqrt(dx2 * dy2)
  return den === 0 ? 0 : num / den
}

/** Average ranks (1-based), ties share the mean rank — for Spearman. */
const rank = (xs: ReadonlyArray<number>): ReadonlyArray<number> => {
  const idx = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x)
  const ranks = new Array<number>(xs.length)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1]!.x === idx[i]!.x) j++
    const avg = (i + j) / 2 + 1 // average of 1-based ranks in the tie block
    for (let k = i; k <= j; k++) ranks[idx[k]!.i] = avg
    i = j + 1
  }
  return ranks
}

/** Spearman rank correlation — robust to the judge using a different SCALE as
 *  long as it orders cases like a human does. */
export const spearman = (xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number =>
  pearson(rank(xs), rank(ys))

/**
 * Cohen's κ on a pass/fail binarization at `threshold` (default 0.5). Corrects
 * agreement for chance: κ=1 perfect, 0 = chance, <0 worse than chance. The honest
 * "do judge and human AGREE on pass/fail" number (raw % agreement is inflated
 * when most cases pass).
 */
export const cohenKappa = (pairs: ReadonlyArray<Pair>, threshold = 0.5): number => {
  const n = pairs.length
  if (n === 0) return 0
  let a = 0 // both pass
  let b = 0 // human pass, judge fail
  let c = 0 // human fail, judge pass
  let d = 0 // both fail
  for (const p of pairs) {
    const hp = p.human >= threshold
    const jp = p.judge >= threshold
    if (hp && jp) a++
    else if (hp && !jp) b++
    else if (!hp && jp) c++
    else d++
  }
  const po = (a + d) / n
  const pHuman = (a + b) / n
  const pJudge = (a + c) / n
  const pe = pHuman * pJudge + (1 - pHuman) * (1 - pJudge)
  return pe === 1 ? 1 : (po - pe) / (1 - pe)
}

export interface CalibrationReport {
  readonly n: number
  readonly mae: number
  readonly rmse: number
  readonly bias: number
  readonly pearson: number
  readonly spearman: number
  readonly kappa: number
  /** Length-bias probe: bias on the longer-than-median outputs MINUS bias on the
   *  shorter half. Large positive ⇒ the judge over-rewards long outputs. */
  readonly lengthBias: number
}

export interface LabeledResult extends Pair {
  /** Output length in chars — for the length-bias probe. */
  readonly length: number
}

export const calibrationReport = (rows: ReadonlyArray<LabeledResult>): CalibrationReport => {
  const sortedLen = [...rows].sort((a, b) => a.length - b.length)
  const mid = Math.floor(sortedLen.length / 2)
  const shortHalf = sortedLen.slice(0, mid)
  const longHalf = sortedLen.slice(mid)
  return {
    n: rows.length,
    mae: mae(rows),
    rmse: rmse(rows),
    bias: bias(rows),
    pearson: pearson(rows.map((r) => r.human), rows.map((r) => r.judge)),
    spearman: spearman(rows.map((r) => r.human), rows.map((r) => r.judge)),
    kappa: cohenKappa(rows),
    lengthBias: bias(longHalf) - bias(shortHalf),
  }
}
