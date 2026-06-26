import { Effect } from "effect"
import { JudgeModel } from "../framework/judge.js"
import { qualityRubric } from "../framework/scorers.js"

/**
 * Judge validation — you can only TRUST the LLM-as-judge axis once you've shown
 * it agrees with humans. This grades a set of HUMAN-LABELLED cases with the same
 * `qualityRubric` judge the suites use, then reports Cohen's κ (chance-corrected
 * agreement) + TPR/TNR (raw agreement misleads under class imbalance — Eugene
 * Yan / Hamel). Grow `JUDGE_LABELS` from real dogfooding cases (the methodology:
 * hand-label ~50) and gate the judge above a κ threshold before trusting it.
 */

export interface LabeledCase {
  readonly name: string
  /** The rubric the judge grades against. */
  readonly rubric: string
  /** The candidate output to grade. */
  readonly output: string
  /** The human verdict: did this output pass the rubric? */
  readonly human: boolean
}

export interface AgreementStats {
  readonly n: number
  readonly rawAgreement: number
  /** Cohen's κ: <0 worse than chance, 0.41–0.60 moderate, 0.61–0.80 substantial. */
  readonly cohensKappa: number
  /** True-positive rate — judge passes the cases humans passed (recall on pass). */
  readonly tpr: number
  /** True-negative rate — judge fails the cases humans failed (recall on fail). */
  readonly tnr: number
  readonly confusion: { readonly tp: number; readonly fp: number; readonly tn: number; readonly fn: number }
}

/** Pure agreement stats from paired binary verdicts. Unit-tested with synthetic data. */
export const agreementStats = (
  humanPass: ReadonlyArray<boolean>,
  judgePass: ReadonlyArray<boolean>,
): AgreementStats => {
  const n = Math.min(humanPass.length, judgePass.length)
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  for (let i = 0; i < n; i++) {
    const h = humanPass[i]!
    const j = judgePass[i]!
    if (h && j) tp++
    else if (!h && j) fp++
    else if (!h && !j) tn++
    else fn++
  }
  const rawAgreement = n === 0 ? 0 : (tp + tn) / n
  // Cohen's κ = (po − pe) / (1 − pe), pe = chance agreement from the marginals.
  const pHumanPos = n === 0 ? 0 : (tp + fn) / n
  const pJudgePos = n === 0 ? 0 : (tp + fp) / n
  const pe = pHumanPos * pJudgePos + (1 - pHumanPos) * (1 - pJudgePos)
  const cohensKappa = pe >= 1 ? 1 : (rawAgreement - pe) / (1 - pe)
  const tpr = tp + fn === 0 ? 1 : tp / (tp + fn)
  const tnr = tn + fp === 0 ? 1 : tn / (tn + fp)
  return { n, rawAgreement, cohensKappa, tpr, tnr, confusion: { tp, fp, tn, fn } }
}

const judgeScorer = qualityRubric<{ readonly rubric: string; readonly output: string }, unknown, unknown>(
  "agreement",
  ({ input }) => ({ rubric: input.rubric, output: input.output }),
)

/** Grade each labelled case with the real judge and compute agreement vs humans.
 *  `passBar` is the score at/above which the judge "passes" a case (default 0.6). */
export const judgeLabeledCases = (
  cases: ReadonlyArray<LabeledCase>,
  passBar = 0.6,
): Effect.Effect<AgreementStats, never, JudgeModel> =>
  Effect.gen(function* () {
    const humanPass: Array<boolean> = []
    const judgePass: Array<boolean> = []
    for (const c of cases) {
      const r = yield* judgeScorer
        .score({ input: { rubric: c.rubric, output: c.output }, output: undefined, expected: undefined })
        .pipe(Effect.orElseSucceed(() => 0))
      const score = typeof r === "number" ? r : r.score
      humanPass.push(c.human)
      judgePass.push(score >= passBar)
    }
    return agreementStats(humanPass, judgePass)
  })

/**
 * Starter labelled set — small + obvious to validate the harness end to end.
 * REPLACE/GROW this with real, borderline dogfooding cases (~50) to get a
 * meaningful κ; a set of only-obvious cases will read κ≈1 trivially.
 */
export const JUDGE_LABELS: ReadonlyArray<LabeledCase> = [
  {
    name: "correct add",
    rubric: "Exports a correct `add(a,b)` returning the sum.",
    output: "export const add = (a: number, b: number): number => a + b",
    human: true,
  },
  {
    name: "wrong add (subtracts)",
    rubric: "Exports a correct `add(a,b)` returning the sum.",
    output: "export const add = (a: number, b: number): number => a - b",
    human: false,
  },
  {
    name: "empty answer",
    rubric: "Explains what exponential backoff is and states the cap.",
    output: "",
    human: false,
  },
  {
    name: "accurate backoff explanation",
    rubric: "Explains exponential backoff (doubling per attempt) and states the 8000ms cap.",
    output: "backoff doubles 1000ms each attempt (1000·2^attempt), capped at 8000ms (8s).",
    human: true,
  },
  {
    name: "off-topic answer",
    rubric: "Identifies where `config` is defined and the value of `config.retries`.",
    output: "Here is a poem about the sea.",
    human: false,
  },
  {
    name: "complete rename",
    rubric: "`add` is renamed to `sum` in both files, consistently, nothing else changed.",
    output: "// math.ts\nexport const sum = (a:number,b:number)=>a+b\n// use.ts\nimport {sum} from './math.js'\nexport const two = sum(1,1)",
    human: true,
  },
  {
    name: "half rename (call site missed)",
    rubric: "`add` is renamed to `sum` in both files, consistently, nothing else changed.",
    output: "// math.ts\nexport const sum = (a:number,b:number)=>a+b\n// use.ts\nimport {add} from './math.js'\nexport const two = add(1,1)",
    human: false,
  },
  {
    name: "correct titleCase",
    rubric: "Exports a correct `titleCase` (e.g. titleCase('hello world')==='Hello World').",
    output: "export const titleCase=(s:string)=>s.split(/\\s+/).map(w=>w[0]?.toUpperCase()+w.slice(1).toLowerCase()).join(' ')",
    human: true,
  },
]
