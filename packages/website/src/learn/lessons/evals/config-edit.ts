// Lesson 13's experiments edit the learner's code in place, so the code and
// the buttons never disagree. A piece the learner rewrote beyond recognition
// is left alone (None) rather than guessed at.
import { Option } from "effect"
import { breakCalculator } from "../test-your-agent/config-edit.ts"
import { ANSWER_CHECK, CASES_END, GATE, REPETITIONS } from "./evals.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** The answer's grader made lenient: an answer passes when there is one, whatever it says. */
export const LENIENT_CHECK = `      // Lenient: an answer passes when there is one, whatever it says.
      const holds = answer !== ""
      const reason = holds ? "there is an answer" : "there is no answer"
`

/**
 * The `lenient` experiment: evals.ts with the lenient grader, and tools.ts with lesson 12's calculator that subtracts
 * where it should add. Both or neither.
 */
export const lenient = { evals: swap(ANSWER_CHECK, LENIENT_CHECK), tools: breakCalculator }

/** The `once` experiment: each task run once for each candidate, not five times. */
export const once = swap(REPETITIONS, "export const repetitions = 1")

/** The gate the `strict-gate` experiment adds: a blocking one on the tool's grader, at every trial. */
export const STRICT_GATE = `  // Strict: every trial calls the right tool with the right numbers, or none where none is asked
  // for. One miss in a candidate's trials fails it.
  {
    grader: "tool@1",
    metric: "called",
    aggregate: "passRate",
    mode: "blocking",
    minimum: Option.some(1),
    maximum: Option.none(),
    requiresReviewedReference: true,
  },
`

/** The `strict-gate` experiment: a second gate after the first, while the list still ends with it. */
export const strictGate = (source: string): Option.Option<string> =>
  source.endsWith(`${GATE}]`) ? Option.some(`${source.slice(0, -1)}${STRICT_GATE}]`) : Option.none()

/** The task the `baseline-misses` experiment adds: the meeting's answer, said in another order, which Echo has no rule for. */
export const MISSED_TASK = `    {
      id: "day",
      family: "text",
      split: "validation",
      review: "reviewed",
      input: "Tuesday is the day of the meeting. When is the meeting?",
      reference: { holds: "Tuesday" },
      provenance: "written by hand",
    },
`

/** The `baseline-misses` experiment: one more task, at the end of the cases, once. */
export const baselineMisses = (source: string): Option.Option<string> =>
  source.includes(MISSED_TASK) ? Option.none() : swap(CASES_END, `${MISSED_TASK}${CASES_END}`)(source)
