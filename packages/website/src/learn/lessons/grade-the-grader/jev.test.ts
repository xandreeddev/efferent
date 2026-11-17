// The real Jev's transport, both ways, with no request to the gateway: the
// package's questions become `decide`'s predicates and the gateway's answers
// come back as the package's, through `makeSemanticJevJudge`'s `evaluate`
// over a fake `fetch` shaped like the gateway's `/v1/decisions` reply. A
// question the gateway refuses, a gateway that fails, and a question that is
// no yes-or-no question each fail in words; the last sends nothing.
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Option, Result } from "effect"
import { makeSemanticJevJudge } from "@xandreed/evals"
import type { SemanticInput } from "@xandreed/evals"
import { gatewayDecider } from "../../models/decide.ts"
import type { Fetch } from "../../models/gateway.ts"
import { answersOf, jevTransport, notYesOrNo, predicatesOf } from "./jev.ts"

const GIVES = "Does the agent's answer give the reference answer, in any words?"
const FALSE = "Does the agent's answer say anything that is false?"
const COMMITS = "Does the agent's answer commit to one answer?"
const STATE = "Question: What is 2 + 3?\nReference answer: 5\nAgent's answer: 5, because 2 + 3 is the same as 2 times 3."

/** asked-thrice's request, as the package's judge is handed it. */
const THRICE: SemanticInput = {
  state: STATE,
  questions: { gives: { type: "boolean", instructions: GIVES }, false: { type: "boolean", instructions: FALSE }, commits: { type: "boolean", instructions: COMMITS } },
}

/** A fake gateway: every request answered with `status` and `body`, each request kept. */
const answering = (status: number, body: unknown) => {
  const sent: Array<{ readonly url: string; readonly body: string }> = []
  const fetchFn: Fetch = (url, init) => { sent.push({ url, body: init.body }); return Promise.resolve(new Response(JSON.stringify(body), { status })) }
  return { fetchFn, sent }
}

/** The gateway's reply to asked-thrice's request, as Jev gave it (the medians of its five runs). */
const REPLY = {
  answers: [
    { type: "predicate", name: "gives", probability: 0.94 },
    { type: "predicate", name: "false", probability: 0.94 },
    { type: "predicate", name: "commits", probability: 0.9 },
  ],
  model: "typesafe-ai/jev",
  usage: { input_tokens: 96, output_tokens: 0, total_tokens: 96 },
}

/** The package's judge over the transport, with the decider given: what its `evaluate` gave, or why it failed. */
const judged = async (fetchFn: Fetch, input: SemanticInput) => {
  const judge = await Effect.runPromise(makeSemanticJevJudge({ evaluate: jevTransport(gatewayDecider(() => Option.some("k"), "typesafe-ai/jev", fetchFn)) }))
  return Effect.runPromiseExit(judge.evaluate(input))
}

const failureOf = (exit: Exit.Exit<unknown, { readonly message: string }>): string =>
  Exit.match(exit, { onSuccess: () => "", onFailure: (cause) => cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error.message] : [])).join("; ") })

describe("the real Jev's transport", () => {
  test("the package's yes-or-no questions are decide's predicates, by name and in order, and the answers come back as boolean answers", () => {
    expect(predicatesOf(THRICE)).toEqual(Result.succeed([
      { type: "predicate", name: "gives", instructions: GIVES },
      { type: "predicate", name: "false", instructions: FALSE },
      { type: "predicate", name: "commits", instructions: COMMITS },
    ]))
    expect(answersOf({ gives: { probability: 0.94 }, false: { probability: 0.94 }, commits: { probability: 0.9 } })).toEqual({
      gives: { type: "boolean", probability: 0.94 },
      false: { type: "boolean", probability: 0.94 },
      commits: { type: "boolean", probability: 0.9 },
    })
  })

  test("a score or a choice question is refused in the page's words, and nothing is sent", async () => {
    const score: SemanticInput = { state: STATE, questions: { gives: { type: "boolean", instructions: GIVES }, helpful: { type: "score", instructions: "How helpful is it?", criteria: ["not", "very"] } } }
    const choice: SemanticInput = { state: STATE, questions: { tone: { type: "choice", instructions: "How does it read?", criteria: { plain: "short", chatty: "long" } } } }
    expect(predicatesOf(score)).toEqual(Result.fail(notYesOrNo("helpful", "score")))
    expect(predicatesOf(choice)).toEqual(Result.fail(notYesOrNo("tone", "choice")))
    expect(notYesOrNo("helpful", "score")).toBe('the page asks Jev yes-or-no questions alone, and "helpful" is a score question: no score or choice reply has been seen from the gateway.')
    const { fetchFn, sent } = answering(200, REPLY)
    expect(failureOf(await judged(fetchFn, score))).toBe(`Jev request failed: ${notYesOrNo("helpful", "score")}`)
    expect(sent).toEqual([])
  })

  test("through the package's judge: one request to the gateway's decisions, and its answers as the package's", async () => {
    const { fetchFn, sent } = answering(200, REPLY)
    const exit = await judged(fetchFn, THRICE)
    expect(Exit.isSuccess(exit) ? exit.value.answers : undefined).toEqual({
      gives: { type: "boolean", probability: 0.94 },
      false: { type: "boolean", probability: 0.94 },
      commits: { type: "boolean", probability: 0.9 },
    })
    expect(sent.map((one) => one.url)).toEqual(["https://ai-gateway.vercel.sh/v1/decisions"])
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({
      model: "typesafe-ai/jev",
      input: STATE,
      questions: [
        { type: "predicate", name: "gives", instructions: GIVES },
        { type: "predicate", name: "false", instructions: FALSE },
        { type: "predicate", name: "commits", instructions: COMMITS },
      ],
    })
  })

  test("a question the gateway refuses, and a gateway that fails, each fail the judge's request in words", async () => {
    const refused = { ...REPLY, answers: [REPLY.answers[0], REPLY.answers[1], { type: "refusal", name: "commits" }] }
    expect(failureOf(await judged(answering(200, refused).fetchFn, THRICE))).toBe('Jev request failed: The decision model gave no answer to "commits": it refused it, or answered in a shape the question does not have.')
    const busy = failureOf(await judged(answering(429, { error: { message: "busy" } }).fetchFn, THRICE))
    // The gateway's own words for a busy provider (`failureOf`, models/gateway.ts).
    expect(busy).toBe("Jev request failed: the gateway is busy, too many requests at once: check the graders again in a moment.")
  })
})

test("a wrong key, a key past its limit and a busy gateway each read in words a learner can act on, not the code's names", async () => {
  const words = await Promise.all([401, 402, 429].map(async (status) => failureOf(await judged(answering(status, "").fetchFn, THRICE))))
  expect(words).toEqual([
    "Jev request failed: The gateway refused the key: it is wrong or no longer valid. Enter it again in the model list.",
    "Jev request failed: the gateway key has reached its spending limit.",
    "Jev request failed: the gateway is busy, too many requests at once: check the graders again in a moment.",
  ])
})
