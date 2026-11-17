// The page's stand-in for Jev: a request it recorded is answered with Jev's
// median answers, keyed on the whole request (the text and every question,
// its name and its words, in order); any other request is refused in its
// words, which the package's judge says after "Jev request failed: ".
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Option } from "effect"
import { makeSemanticJevJudge } from "@xandreed/evals"
import type { SemanticInput } from "@xandreed/evals"
import { NOT_RECORDED, RECORDED, recordedAnswers, standIn } from "./stand-in.ts"

const GIVES = "Does the agent's answer give the reference answer, in any words?"
const FALSE = "Does the agent's answer say anything that is false?"
const COMMITS = "Does the agent's answer commit to one answer?"
const LISBOA = "Question: What is the capital of Portugal?\nReference answer: Lisbon\nAgent's answer: Lisboa."

const once = (state: string, gives = GIVES): SemanticInput => ({ state, questions: { gives: { type: "boolean", instructions: gives } } })
const thrice = (state: string): SemanticInput => ({
  state,
  questions: { gives: { type: "boolean", instructions: GIVES }, false: { type: "boolean", instructions: FALSE }, commits: { type: "boolean", instructions: COMMITS } },
})

/** The package's judge over the stand-in: its answers, or the words it failed with. */
const judged = async (input: SemanticInput) => {
  const judge = await Effect.runPromise(makeSemanticJevJudge({ evaluate: standIn }))
  return Exit.match(await Effect.runPromiseExit(judge.evaluate(input)), {
    onSuccess: (result): unknown => result.answers,
    onFailure: (cause) => cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error.message] : [])).join("; "),
  })
}

describe("the stand-in for Jev", () => {
  test("a request it holds is answered with Jev's median, by the whole request: gives alone is not gives beside two other questions", async () => {
    expect(recordedAnswers(once(LISBOA))).toEqual(Option.some({ gives: 0.7 }))
    expect(recordedAnswers(thrice(LISBOA))).toEqual(Option.some({ gives: 0.71, false: 0.03, commits: 0.96 }))
    expect(await judged(once(LISBOA))).toEqual({ gives: { type: "boolean", probability: 0.7 } })
    expect(await judged(thrice(LISBOA))).toEqual({
      gives: { type: "boolean", probability: 0.71 },
      false: { type: "boolean", probability: 0.03 },
      commits: { type: "boolean", probability: 0.96 },
    })
  })

  test("the table keeps Jev's five runs of each of the sixteen requests; the medians are the page's, and every verdict at the starter's bars held in all five", () => {
    expect(RECORDED).toHaveLength(16)
    expect(RECORDED.every((row) => Object.values(row.runs).every((runs) => runs.length === 5))).toBe(true)
    const medians = RECORDED.map((row) => Option.getOrThrow(recordedAnswers({ state: row.state, questions: Object.fromEntries(row.questions.map(([name, instructions]) => [name, { type: "boolean", instructions }])) })))
    expect(medians).toEqual([
      { gives: 0.98 }, { gives: 0.98 }, { gives: 0.7 }, { gives: 0.93 }, { gives: 0.94 }, { gives: 0.98 }, { gives: 0.95 }, { gives: 0.37 },
      { gives: 0.98, false: 0.02, commits: 0.97 }, { gives: 0.98, false: 0.03, commits: 0.96 }, { gives: 0.71, false: 0.03, commits: 0.96 },
      { gives: 0.93, false: 0.11, commits: 0.29 }, { gives: 0.94, false: 0.94, commits: 0.9 }, { gives: 0.99, false: 0.98, commits: 0.64 },
      { gives: 0.95, false: 0.51, commits: 0.08 }, { gives: 0.37, false: 0.98, commits: 0.8 },
    ])
    // Each run's verdict at the starter's bars: asked-once passes at gives 0.5; asked-thrice at gives 0.5, false under
    // 0.5 and commits 0.5. Every request's five verdicts are one verdict.
    const verdict = (runs: Readonly<Record<string, ReadonlyArray<number>>>, index: number) =>
      (runs.gives?.[index] ?? 0) >= 0.5 && (runs.false === undefined || (runs.false[index] ?? 1) < 0.5) && (runs.commits === undefined || (runs.commits[index] ?? 0) >= 0.5)
    expect(RECORDED.map((row) => [0, 1, 2, 3, 4].map((index) => verdict(row.runs, index)))).toEqual([
      ...[true, true, true, true, true, true, true, false].map((one) => Array.from({ length: 5 }, () => one)),
      ...[true, true, true, false, false, false, false, false].map((one) => Array.from({ length: 5 }, () => one)),
    ])
    // Case 4's commits, over the five runs: between 0.28 and 0.31.
    const hedge = RECORDED[11]?.runs.commits ?? []
    expect(hedge).toHaveLength(5)
    expect([Math.min(...hedge), Math.max(...hedge)]).toEqual([0.28, 0.31])
  })

  test("an edited question, an edited answer, questions in another order and a case it never saw are each refused, in its words", async () => {
    const refused = `Jev request failed: ${NOT_RECORDED}`
    expect(NOT_RECORDED).toBe("the stand-in has no recorded answer to this request: it holds Jev's answers to the starter's eight cases, asked as graders.ts first asks them. Keep an AI Gateway key in the gateway's card in the model list, and the real Jev answers it.")
    // The question's words edited.
    expect(await judged(once(LISBOA, "Does the agent's answer name the reference answer?"))).toBe(refused)
    // The answer's text edited.
    expect(await judged(once(LISBOA.replace("Lisboa.", "Lisboa!")))).toBe(refused)
    // The same three questions in another order.
    const reordered: SemanticInput = { state: LISBOA, questions: { commits: { type: "boolean", instructions: COMMITS }, gives: { type: "boolean", instructions: GIVES }, false: { type: "boolean", instructions: FALSE } } }
    expect(await judged(reordered)).toBe(refused)
    // A case of the learner's own.
    expect(await judged(once("Question: How many legs does a spider have?\nReference answer: 8\nAgent's answer: Eight."))).toBe(refused)
    expect(recordedAnswers(once("anything"))).toEqual(Option.none())
  })
})
