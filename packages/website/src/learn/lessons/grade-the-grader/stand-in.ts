// The page's stand-in for Jev, for a page with no AI Gateway key kept: Jev's own answers to the
// sixteen requests the starter makes (each of the eight cases asked by asked-once, and again by
// asked-thrice), recorded through the gateway on 17 November 2026. Each request was sent five
// times, and the table keeps all five; the stand-in answers with the middle of the five (the
// median). Every verdict at the starter's bars was the same in all five (a test pins it). A
// request is found by its whole text: the case Jev reads and every question, its name, its kind
// and its words, in order. So asked-once is never answered with a `gives` that Jev gave beside two
// other questions, and an edited question, an edited answer or a case of the learner's own is not
// found: it is refused in words that ask for a key. Echo has no meaning to read, so the page
// invents no judge.
import { Option } from "effect"
import type { SemanticInput, SemanticJevOptions } from "@xandreed/evals"

/** The day the answers were recorded, as the page says it. */
export const RECORDED_ON = "17 November 2026"

/** How many requests the starter's press makes: eight for asked-once, eight for asked-thrice. */
export const STARTER_REQUESTS = 16

/** Why a request is refused: the stand-in holds no answer to it. */
export const NOT_RECORDED =
  "the stand-in has no recorded answer to this request: it holds Jev's answers to the starter's eight cases, asked as graders.ts first asks them. Keep an AI Gateway key in the gateway's card in the model list, and the real Jev answers it."

const GIVES = "Does the agent's answer give the reference answer, in any words?"
const FALSE = "Does the agent's answer say anything that is false?"
const COMMITS = "Does the agent's answer commit to one answer?"

/** asked-once's question, and asked-thrice's three, as the starter asks them: each name and its words, in order. */
const ONCE: ReadonlyArray<readonly [string, string]> = [["gives", GIVES]]
const THRICE: ReadonlyArray<readonly [string, string]> = [["gives", GIVES], ["false", FALSE], ["commits", COMMITS]]

/** One recorded request: the text Jev read, the yes-or-no questions it was asked, and its probabilities in each of five runs. */
interface Recorded {
  readonly state: string
  readonly questions: ReadonlyArray<readonly [name: string, instructions: string]>
  readonly runs: Readonly<Record<string, ReadonlyArray<number>>>
}

/** The table: one data value, every request the starter makes and Jev's answers to it in each of its five runs. */
export const RECORDED: ReadonlyArray<Recorded> = [
  { state: "Question: What is 2 + 3?\nReference answer: 5\nAgent's answer: 2 + 3 = 5.", questions: ONCE, runs: { gives: [0.98, 0.98, 0.98, 0.97, 0.97] } },
  { state: "Question: What is 2 + 3?\nReference answer: 5\nAgent's answer: Five.", questions: ONCE, runs: { gives: [0.98, 0.98, 0.98, 0.98, 0.98] } },
  { state: "Question: What is the capital of Portugal?\nReference answer: Lisbon\nAgent's answer: Lisboa.", questions: ONCE, runs: { gives: [0.68, 0.73, 0.69, 0.7, 0.7] } },
  { state: "Question: What is 2 + 3?\nReference answer: 5\nAgent's answer: I think it might be 5, but I am not sure.", questions: ONCE, runs: { gives: [0.93, 0.93, 0.92, 0.93, 0.93] } },
  { state: "Question: What is 2 + 3?\nReference answer: 5\nAgent's answer: 5, because 2 + 3 is the same as 2 times 3.", questions: ONCE, runs: { gives: [0.93, 0.94, 0.93, 0.96, 0.95] } },
  { state: "Question: What is the capital of Portugal?\nReference answer: Lisbon\nAgent's answer: Lisbon, which is also the capital of Spain.", questions: ONCE, runs: { gives: [0.99, 0.98, 0.98, 0.98, 0.98] } },
  { state: "Question: Where is the key?\nReference answer: under the mat\nAgent's answer: Probably under the mat or in the drawer.", questions: ONCE, runs: { gives: [0.95, 0.94, 0.95, 0.94, 0.95] } },
  { state: "Question: What is the capital of Portugal?\nReference answer: Lisbon\nAgent's answer: Porto, not Lisbon.", questions: ONCE, runs: { gives: [0.4, 0.37, 0.36, 0.45, 0.32] } },
  { state: "Question: What is 2 + 3?\nReference answer: 5\nAgent's answer: 2 + 3 = 5.", questions: THRICE, runs: { gives: [0.98, 0.98, 0.98, 0.98, 0.98], false: [0.02, 0.02, 0.02, 0.02, 0.02], commits: [0.97, 0.97, 0.97, 0.97, 0.97] } },
  { state: "Question: What is 2 + 3?\nReference answer: 5\nAgent's answer: Five.", questions: THRICE, runs: { gives: [0.98, 0.98, 0.97, 0.98, 0.98], false: [0.03, 0.03, 0.03, 0.02, 0.03], commits: [0.96, 0.96, 0.96, 0.96, 0.96] } },
  { state: "Question: What is the capital of Portugal?\nReference answer: Lisbon\nAgent's answer: Lisboa.", questions: THRICE, runs: { gives: [0.74, 0.68, 0.76, 0.71, 0.69], false: [0.03, 0.03, 0.03, 0.03, 0.03], commits: [0.96, 0.96, 0.96, 0.96, 0.96] } },
  { state: "Question: What is 2 + 3?\nReference answer: 5\nAgent's answer: I think it might be 5, but I am not sure.", questions: THRICE, runs: { gives: [0.93, 0.94, 0.92, 0.94, 0.93], false: [0.11, 0.11, 0.13, 0.1, 0.11], commits: [0.28, 0.31, 0.29, 0.28, 0.3] } },
  { state: "Question: What is 2 + 3?\nReference answer: 5\nAgent's answer: 5, because 2 + 3 is the same as 2 times 3.", questions: THRICE, runs: { gives: [0.94, 0.95, 0.95, 0.93, 0.93], false: [0.94, 0.95, 0.94, 0.94, 0.94], commits: [0.9, 0.9, 0.89, 0.89, 0.9] } },
  { state: "Question: What is the capital of Portugal?\nReference answer: Lisbon\nAgent's answer: Lisbon, which is also the capital of Spain.", questions: THRICE, runs: { gives: [0.98, 0.99, 0.98, 0.99, 0.99], false: [0.98, 0.98, 0.98, 0.98, 0.98], commits: [0.63, 0.64, 0.64, 0.64, 0.63] } },
  { state: "Question: Where is the key?\nReference answer: under the mat\nAgent's answer: Probably under the mat or in the drawer.", questions: THRICE, runs: { gives: [0.95, 0.94, 0.95, 0.95, 0.95], false: [0.53, 0.51, 0.46, 0.51, 0.44], commits: [0.09, 0.08, 0.08, 0.09, 0.08] } },
  { state: "Question: What is the capital of Portugal?\nReference answer: Lisbon\nAgent's answer: Porto, not Lisbon.", questions: THRICE, runs: { gives: [0.42, 0.33, 0.37, 0.45, 0.35], false: [0.98, 0.98, 0.98, 0.98, 0.98], commits: [0.81, 0.81, 0.8, 0.79, 0.8] } },
]

/** The middle of a list of numbers: of five runs, the third from the lowest. */
const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * The recorded answers to a request, or none: a request is the one recorded when its text is the same and its
 * questions are the same yes-or-no questions, each with its name and words, in the same order. Each answer is the
 * median of its five runs.
 */
export const recordedAnswers = (input: SemanticInput): Option.Option<Readonly<Record<string, number>>> => {
  const asked = Object.entries(input.questions)
  return Option.map(
    Option.fromNullishOr(RECORDED.find((row) => row.state === input.state && row.questions.length === asked.length &&
      row.questions.every(([name, instructions], index) => {
        const [askedName, question] = asked[index] ?? ["", undefined]
        return askedName === name && question?.type === "boolean" && question.instructions === instructions
      }))),
    (row) => Object.fromEntries(Object.entries(row.runs).map(([name, runs]) => [name, median(runs)])),
  )
}

/** The stand-in as the package's judge takes a transport: the recorded answers, or a refusal in the page's words. */
export const standIn: SemanticJevOptions["evaluate"] = (input) =>
  Option.match(recordedAnswers(input), {
    onNone: () => Promise.reject(new Error(NOT_RECORDED)),
    onSome: (answers) => Promise.resolve({ answers: Object.fromEntries(Object.entries(answers).map(([name, probability]) => [name, { type: "boolean", probability }])) }),
  })
