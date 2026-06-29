import { Effect } from "effect"
import { JudgeModel } from "../framework/judge.js"
import { qualityRubric } from "../framework/scorers.js"
import type { GoldenCase } from "./judgeGolden.js"
import type { LabeledResult } from "./metrics.js"

/**
 * Graded judge calibration — the continuous-score complement to the binary
 * `judgeAgreement` (κ/TPR/TNR). Binary agreement can't tell that the judge gave
 * 0.9 to something a human scored 0.6 (both "pass"): the continuous metrics
 * (MAE/correlation/bias/length-bias from `metrics.ts`) catch miscalibration
 * WITHIN the pass/fail classes, and the adversarial golden set (`judgeGolden.ts`)
 * probes the known LLM-judge failure modes (length/brevity/honesty).
 *
 * Reuses the exact `qualityRubric` judge the semantic suites use, so the numbers
 * describe the judge those suites actually trust.
 */
const judgeScorer = qualityRubric<{ readonly rubric: string; readonly output: string }, unknown, unknown>(
  "calibration",
  ({ input }) => ({ rubric: input.rubric, output: input.output }),
)

export const judgeGradedCases = (
  cases: ReadonlyArray<GoldenCase>,
): Effect.Effect<ReadonlyArray<LabeledResult>, never, JudgeModel> =>
  Effect.gen(function* () {
    const rows: Array<LabeledResult> = []
    for (const c of cases) {
      const r = yield* judgeScorer
        .score({ input: { rubric: c.rubric, output: c.output }, output: undefined, expected: undefined })
        .pipe(Effect.orElseSucceed(() => 0))
      const judge = typeof r === "number" ? r : r.score
      rows.push({ human: c.human, judge, length: c.output.length })
    }
    return rows
  })
