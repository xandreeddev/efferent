// Lesson 19's graders.ts: the three graders checked against the labels,
// each one of the eval package's `Evaluator`s. The learner edits all of it,
// as plain JavaScript the page runs as written; its typed module holds each
// name to the package's types (`TYPED`). The model graders read
// `SemanticJudge`, the package's judge, which calibration.ts provides.
import { replaced } from "../base/agent.source.ts"

/** Read-only: where each name the file uses comes from. */
export const GRADERS_IMPORTS = `import { Effect } from "effect"
import { SemanticJudge } from "@xandreed/evals"`

/** Everything before the editable part. */
export const GRADERS_HEADER = `${GRADERS_IMPORTS}\n\n`

/** The bar `asked-once` holds `gives` to, as the file starts: the `once-stricter` experiment raises it. */
export const ONCE_BAR = "const ONCE_GIVES = 0.5"

/** The bar `asked-thrice` holds `commits` to, as the file starts: the `commit-lower` experiment lowers it. */
export const COMMITS_BAR = "const THRICE_COMMITS = 0.5"

/** What the learner edits. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_GRADERS = `// The graders, each one of the eval package's Evaluators: an id, a version, the metrics it gives,
// and run, with kind beside them: "code" for a rule written in code, "model" for a grader that
// asks a model. run is handed one labelled answer (its question, its reference and the answer,
// never the label) and gives one metric, correct, yes or no, with the reason in words.

// The bars. Jev answers each question with a probability: a number from 0 to 1, how likely it
// finds that the answer is yes. A bar is the number a probability must reach (or, for "says
// something false", stay under) for the grader to say yes. Change a bar, and check the graders
// again.
const ONCE_GIVES = 0.5
const THRICE_GIVES = 0.5
const THRICE_FALSE = 0.5
const THRICE_COMMITS = 0.5

// What Jev reads: the question, the reference answer and the agent's answer, a line each.
const stateOf = ({ question, reference, answer }) =>
  \`Question: \${question}\\nReference answer: \${reference}\\nAgent's answer: \${answer}\`

// The questions put to Jev, each a predicate: a statement about what it reads that is true or
// false. Jev answers each with the probability that it is true.
const GIVES = {
  type: "boolean",
  instructions: "Does the agent's answer give the reference answer, in any words?",
}
const FALSE = {
  type: "boolean",
  instructions: "Does the agent's answer say anything that is false?",
}
const COMMITS = {
  type: "boolean",
  instructions: "Does the agent's answer commit to one answer?",
}

// The probability Jev gave one question. The judge has checked that each question it was asked
// has its answer; a name it was not asked has none, and reads as 0.
const probabilityOf = (answers, name) => {
  const answer = answers[name]
  return answer?.type === "boolean" ? answer.probability : 0
}

// A grade: the one metric, correct, and the reason in words.
const graded = (correct, reason) => ({
  metrics: [{ kind: "boolean", name: "correct", value: correct }],
  reason,
})

export const graders = [
  // Lesson 13's rule: the answer is right when it holds the reference's text.
  {
    id: "text",
    version: "1",
    kind: "code",
    metrics: ["correct"],
    run: ({ reference, answer }) => {
      const holds = answer.includes(reference)
      const reason = \`the answer \${holds ? "holds" : "does not hold"} "\${reference}"\`
      return Effect.succeed(graded(holds, reason))
    },
  },
  // A model grader: Jev is asked one question, whether the answer gives the reference answer.
  {
    id: "asked-once",
    version: "1",
    kind: "model",
    metrics: ["correct"],
    run: (labelled) =>
      Effect.gen(function* () {
        const judge = yield* SemanticJudge
        const { answers } = yield* judge.evaluate({
          state: stateOf(labelled),
          questions: { gives: GIVES },
        })
        const gives = probabilityOf(answers, "gives")
        return graded(gives >= ONCE_GIVES, \`gives the reference answer: \${gives}\`)
      }),
  },
  // Jev is asked three questions in one request: whether the answer gives the reference answer,
  // whether it says anything false, and whether it commits to one answer. Right is all three.
  {
    id: "asked-thrice",
    version: "1",
    kind: "model",
    metrics: ["correct"],
    run: (labelled) =>
      Effect.gen(function* () {
        const judge = yield* SemanticJudge
        const { answers } = yield* judge.evaluate({
          state: stateOf(labelled),
          questions: { gives: GIVES, false: FALSE, commits: COMMITS },
        })
        const gives = probabilityOf(answers, "gives")
        const saysFalse = probabilityOf(answers, "false")
        const commits = probabilityOf(answers, "commits")
        const correct =
          gives >= THRICE_GIVES && saysFalse < THRICE_FALSE && commits >= THRICE_COMMITS
        const reason = \`gives the reference answer: \${gives}; says something false: \${saysFalse}; commits to one answer: \${commits}\`
        return graded(correct, reason)
      }),
  },
]`

/** The whole file as the learner reads it. */
export const gradersDocumentOf = (graders: string): string => `${GRADERS_HEADER}${graders}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const gradersBodyOf = (graders: string): string => graders.replace(/^export /gm, "")

/**
 * The lines of graders.ts that take a type in the module a test compiles, as `[from, to]`: what a grader reads is
 * calibration.ts's `Case`, a question is the package's `SemanticQuestion`, the answers its `SemanticAnswers`, a
 * grade an `Assessment`, and the list a list of `Evaluator`s that may read the judge, each with its kind. program.test.ts fails when the
 * starter text no longer holds one of them.
 */
export const TYPED: ReadonlyArray<readonly [string, string]> = [
  ["const stateOf = ({ question, reference, answer }) =>", "const stateOf = ({ question, reference, answer }: Case): string =>"],
  ["const GIVES = {", "const GIVES: SemanticQuestion = {"],
  ["const FALSE = {", "const FALSE: SemanticQuestion = {"],
  ["const COMMITS = {", "const COMMITS: SemanticQuestion = {"],
  ["const probabilityOf = (answers, name) =>", "const probabilityOf = (answers: SemanticAnswers, name: string): number =>"],
  ["const graded = (correct, reason) =>", "const graded = (correct: boolean, reason: string): Assessment =>"],
  ["export const graders = [", 'export const graders: ReadonlyArray<Evaluator<Case, SemanticJudge> & { readonly kind: "code" | "model" }> = ['],
]

/** The same file as a module a test can compile: its imports, the types it is held to, and the text typed. */
export const gradersModuleOf = (graders: string): string => `${GRADERS_IMPORTS}
import type { Assessment, Evaluator, SemanticAnswers, SemanticQuestion } from "@xandreed/evals"
import type { Case } from "./calibration.ts"

${replaced(graders, TYPED)}
`
